import AVFoundation
import SwiftUI
import UIKit

/// The app's brain: ties the session link, the mic, transcription and Claude's voice together.
/// Mirrors the Mac app (src/renderer.js + src/main.js).
@MainActor
final class VoiceController: ObservableObject {
    struct Caption: Equatable { var role: Role; var text: String; var partial: Bool; enum Role { case user, assistant } }
    struct Note: Equatable { var text: String; var kind: Kind; enum Kind { case info, warn, error } }

    @Published var settings = Settings.load()
    @Published private(set) var pairedMacs = PairedMac.all()
    @Published private(set) var listening = false
    @Published private(set) var speaking = false
    @Published private(set) var waitingForClaude = false
    @Published private(set) var caption: Caption?
    @Published private(set) var note: Note?
    @Published private(set) var permission: PermissionRequest?
    @Published private(set) var permissionAnswer: String?
    @Published private(set) var agents: [Agent] = []
    @Published private(set) var activity = ClaudeActivity()
    @Published var showAgents = false
    @Published private(set) var history: [HistoryEntry] = []
    /// Desktop-app session with no Monitor armed: it can't hear the user until /voice phone is run there.
    @Published private(set) var needsAttach = false
    @Published var contextText = ""

    let channel = ChannelClient()
    let discovery = Discovery()
    let audio = AudioIO()
    var meter: Meter { audio.meter }

    private let transcriber = Transcriber()
    private let speaker = Speaker()
    private lazy var live = LiveSession(meter: audio.meter)
    private var starting = false
    private var assistantFull: [Int: String] = [:]
    private var userBubble: String?          // stt item currently shown
    private var earlyLogs: [String: [AgentLogLine]] = [:]
    /// A thread we asked a Mac to open: connect to it once it shows up.
    private var pendingThread: (macID: String, since: Date)?
    private var lastSessionKey: String? = UserDefaults.standard.string(forKey: "lastSession")
    private let historyStore = HistoryStore()

    var connected: Bool { channel.state == .connected }
    var hasKey: Bool { !settings.openaiKey.isEmpty }
    /// GPT-Live is built for full duplex; the other engines only if "interrupt by talking" is on.
    var fullDuplex: Bool { settings.engine == .live || settings.bargeIn }
    var runningAgents: Int { agents.filter(\.running).count }

    init() {
        speaker.settings = settings
        wire()
        refreshHistory()
    }

    // MARK: wiring

    private func wire() {
        channel.onStateChange = { [weak self] state, reason in self?.channelChanged(state, reason) }
        channel.onSpeak = { [weak self] text in
            guard let self else { return }
            self.record(.received, text)
            self.needsAttach = false
            if self.settings.engine == .live { self.live.relay(text) } else { self.speaker.say(text) }
        }
        channel.onPermission = { [weak self] req in self?.permissionRequested(req) }
        channel.onAgents = { [weak self] list in self?.agents = list.sorted { $0.startedAt > $1.startedAt } }
        channel.onAgent = { [weak self] a in self?.agentUpdated(a) }
        channel.onActivity = { [weak self] a in
            guard let self else { return }
            self.activity = a
            self.waitingForClaude = a.busy
            if !a.busy { self.historyStore.settle(); self.refreshHistory() }
        }
        channel.onMonitor = { [weak self] count, needed in
            guard let self else { return }
            self.needsAttach = needed && count == 0
        }
        channel.onNeedsAttach = { [weak self] in
            guard let self else { return }
            self.needsAttach = true
            self.waitingForClaude = false
        }
        channel.onAgentLog = { [weak self] id, line in
            guard let self else { return }
            // The server logs an agent's prompt just before announcing the agent; keep it for then.
            guard let i = self.agents.firstIndex(where: { $0.id == id }) else { self.earlyLogs[id, default: []].append(line); return }
            self.agents[i].log.append(line)
            if self.agents[i].log.count > 400 { self.agents[i].log.removeFirst() }
        }

        audio.onSpeakingChange = { [weak self] on in
            guard let self else { return }
            self.speaking = on
            if !on { self.transcriber.clear() }
        }
        audio.onMicFrame = { [weak self] pcm, peak in
            DispatchQueue.main.async { self?.micFrame(pcm, peak: peak) }
        }

        transcriber.onEvent = { [weak self] ev in self?.transcription(ev) }
        speaker.onAudio = { [weak self] pcm in self?.audio.play(pcm) }
        speaker.onEvent = { [weak self] ev in self?.speech(ev) }
        live.onEvent = { [weak self] ev in self?.liveEvent(ev) }
    }

    func start() {
        discovery.start()
        speaker.warmUp()
    }

    // MARK: sessions & pairing

    func sessionsForPairedMacs(_ all: [SessionInfo]) -> [SessionInfo] {
        let ids = Set(pairedMacs.map(\.id))
        return all.filter { ids.contains($0.macID) }
    }

    /// Reconnect to the last session when it shows up, or to the only one there is.
    func sessionsChanged(_ all: [SessionInfo]) {
        if let p = pendingThread {
            if let s = all.first(where: { $0.macID == p.macID && ($0.started ?? .distantPast) > p.since }) {
                pendingThread = nil
                connect(s)
                return
            }
            if Date().timeIntervalSince(p.since) > 120 { pendingThread = nil }
        }
        guard channel.session == nil else { return }
        let mine = sessionsForPairedMacs(all)
        if let key = lastSessionKey, let s = mine.first(where: { Self.key($0) == key }) { connect(s) }
        else if mine.count == 1, lastSessionKey == nil { connect(mine[0]) }
    }

    private static func key(_ s: SessionInfo) -> String { "\(s.macID)|\(s.id)" }

    func connect(_ s: SessionInfo) {
        guard let token = pairedMacs.first(where: { $0.id == s.macID })?.token else {
            note = Note(text: "\(s.machine) isn't paired. Run claude-voice pair on it and scan the code.", kind: .warn)
            return
        }
        lastSessionKey = Self.key(s)
        needsAttach = false
        defer { refreshHistory() }
        UserDefaults.standard.set(lastSessionKey, forKey: "lastSession")
        channel.connect(to: s, token: token)
    }

    func disconnect() {
        lastSessionKey = nil
        UserDefaults.standard.removeObject(forKey: "lastSession")
        channel.disconnect()
    }

    @discardableResult
    func pair(url: URL) -> Bool {
        guard let (mac, token) = PairedMac.from(url: url) else { return false }
        pair(mac, token: token)
        return true
    }

    func pair(_ mac: PairedMac, token: String) {
        Keychain.set("pair:\(mac.id)", token)
        pairedMacs.removeAll { $0.id == mac.id }
        pairedMacs.append(mac)
        PairedMac.save(pairedMacs)
        note = Note(text: "Paired with \(mac.name).", kind: .info)
        sessionsChanged(discovery.sessions)
        discovery.restart()
    }

    func unpair(_ mac: PairedMac) {
        Keychain.set("pair:\(mac.id)", nil)
        pairedMacs.removeAll { $0.id == mac.id }
        PairedMac.save(pairedMacs)
        if channel.session?.macID == mac.id { disconnect() }
    }

    private func channelChanged(_ state: ChannelClient.State, _ reason: String?) {
        objectWillChange.send()
        switch state {
        case .connected:
            note = Note(text: "Attached to the Claude Code thread in \(channel.session?.project ?? "your project")", kind: .info)
            if !listening && hasKey { startListening() }
        case .disconnected:
            waitingForClaude = false
            activity = ClaudeActivity()
            if channel.session != nil || reason != nil {
                note = Note(text: "Thread disconnected\(reason.map { " — \($0)" } ?? ""). Pick a session to reattach.", kind: .warn)
                stopListening()
            }
        case .connecting: break
        }
    }

    // MARK: mic

    func toggleMic() { listening ? stopListening() : startListening() }

    /// Big button: stop Claude talking first, otherwise toggle the mic.
    func primaryAction() {
        if speaking || speaker.isBusy { interrupt() } else { toggleMic() }
    }

    func startListening() {
        guard !listening, !starting else { return }
        guard hasKey else { note = Note(text: "Add your OpenAI API key in Settings.", kind: .warn); return }
        starting = true
        Task {
            defer { starting = false }
            guard await AVAudioApplication.requestRecordPermission() else {
                note = Note(text: "Microphone unavailable. Allow it in Settings → Claude Voice → Microphone.", kind: .error)
                return
            }
            if settings.engine == .live {
                speaker.stop()
                audio.shutdown()
                live.open(settings: settings)
            } else {
                do { try audio.setMic(true) } catch {
                    note = Note(text: "Microphone: \(error.localizedDescription)", kind: .error); return
                }
                transcriber.open(settings: settings)
            }
            listening = true
            UIApplication.shared.isIdleTimerDisabled = true
        }
    }

    func stopListening() {
        guard listening else { return }
        listening = false
        UIApplication.shared.isIdleTimerDisabled = false
        transcriber.close()
        live.close()
        try? audio.setMic(false)
    }

    private func micFrame(_ pcm: Data, peak: Float) {
        guard listening, settings.engine != .live else { return }
        if !speaking {
            bargeIn.reset()
            transcriber.append(pcm)
            return
        }
        let interrupted = fullDuplex && bargeIn.check(peak, pcm)
        if interrupted { interrupt() }
        // While Claude talks, the speaker leaks into the mic. The transcriber only gets silence then,
        // so it can't transcribe (and answer) Claude's own voice. On a real barge-in, replay the
        // recent frames so the start of what the user said isn't lost.
        if interrupted { bargeIn.recent.forEach(transcriber.append); bargeIn.recent.removeAll() }
        else { transcriber.append(Data(count: pcm.count)) }
    }

    /// Local barge-in: cut Claude off the moment the user talks over it. Echo cancellation never
    /// removes Claude's voice completely, so learn how loud the leftover echo is (a slow average of
    /// mic frames while Claude talks) and only count frames clearly above it. ~300 ms triggers it.
    private struct BargeIn {
        var echo: Float = 0      // typical mic level of Claude's own voice leaking back in
        var loud = 0             // consecutive loud frames
        var recent: [Data] = []  // last ~500 ms of mic frames (100 ms each)

        mutating func reset() { loud = 0; recent.removeAll() }

        mutating func check(_ level: Float, _ pcm: Data) -> Bool {
            recent.append(pcm)
            if recent.count > 5 { recent.removeFirst() }
            if level > max(0.2, echo * 3) {
                loud += 1
                if loud < 3 { return false }
                loud = 0
                return true
            }
            loud = 0
            echo = echo > 0 ? echo * 0.95 + level * 0.05 : level
            return false
        }
    }
    private var bargeIn = BargeIn()

    private func interrupt() {
        stopSpeaking()
        live.duck(0.7)
        // The server keeps streaming for a moment before it registers the interruption.
        audio.stopPlayback(muteFor: 0.7)
    }

    func stopSpeaking() {
        speaker.stop()
        audio.stopPlayback()
        if case .assistant = caption?.role, let c = caption { caption = Caption(role: .assistant, text: c.text, partial: false) }
    }

    // MARK: transcription (realtime / tts engines)

    private func transcription(_ ev: Transcriber.Event) {
        switch ev {
        case .open: break
        case .closed(let reason):
            if listening {
                stopListening()
                if let reason { note = Note(text: "Transcription closed (\(reason)).", kind: .error) }
            }
        case .error(let msg): note = Note(text: msg, kind: .error)
        case .speechStarted(let id):
            userBubble = id
            caption = Caption(role: .user, text: "…", partial: true)
        case .speechStopped(let id):
            // Noise that never produces a transcript: drop the placeholder.
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, self.userBubble == id, self.caption?.text == "…" else { return }
                self.caption = nil
            }
        case .delta(let id, let text):
            userDelta(id, text)
        case .final(let id, let text):
            if userBubble == id { userBubble = nil }
            guard !text.isEmpty else { if caption?.text == "…" { caption = nil }; return }
            caption = Caption(role: .user, text: text, partial: false)
            handleUtterance(text, forward: true)
        }
    }

    private func userDelta(_ id: String, _ text: String) {
        if userBubble != id || caption?.role != .user { userBubble = id; caption = Caption(role: .user, text: "", partial: true) }
        var c = caption!
        if c.text == "…" { c.text = "" }
        c.text += text
        caption = c
    }

    // MARK: Claude's voice

    private func speech(_ ev: Speaker.Event) {
        switch ev {
        case .start(let id, let text):
            waitingForClaude = false
            assistantFull[id] = text
            caption = Caption(role: .assistant, text: "", partial: true)
        case .text(_, let delta):
            if caption?.role == .assistant { caption?.text += delta }
        case .end(let id):
            // Show exactly what Claude said, even if the voice model's transcript differs slightly.
            if let full = assistantFull.removeValue(forKey: id), caption?.role == .assistant, caption?.partial == true {
                caption = Caption(role: .assistant, text: full, partial: false)
            }
        case .error(let msg):
            note = Note(text: msg, kind: .error)
        }
    }

    // MARK: GPT-Live

    private func liveEvent(_ ev: LiveSession.Event) {
        switch ev {
        case .open: break
        case .userDelta(let id, let text):
            if speaking { interrupt() }  // GPT-Live heard the user over itself
            userDelta(id, text)
        case .userFinal(let id):
            if userBubble == id, let c = caption, c.role == .user {
                caption = Caption(role: .user, text: c.text.trimmingCharacters(in: .whitespaces), partial: false)
                handleUtterance(c.text, forward: false)  // speech reaches Claude when GPT-Live delegates
            }
        case .assistantStart:
            caption = Caption(role: .assistant, text: "", partial: true)
        case .assistantDelta(_, let d):
            if caption?.role == .assistant { caption?.text += d }
        case .assistantEnd:
            if caption?.role == .assistant { caption?.partial = false }
        case .delegate(let text):
            if sendToThread(text) { waitingForClaude = true }
        case .speaking(let on):
            speaking = on
        case .error(let msg):
            note = Note(text: msg, kind: .error)
        case .closed(let reason):
            if listening {
                listening = false
                UIApplication.shared.isIdleTimerDisabled = false
                if let reason { note = Note(text: "GPT-Live closed (\(reason)).", kind: .error) }
            }
            speaking = false
        }
    }

    // MARK: talking to the thread

    private static let yes = try! NSRegularExpression(pattern: #"^\s*(yes|yeah|yep|yup|sure|ok(ay)?|allow|approve|go ahead|do it|sim|pode)\b"#, options: .caseInsensitive)
    private static let no = try! NSRegularExpression(pattern: #"^\s*(no|nope|nah|deny|don'?t|stop|cancel|não|nao)\b"#, options: .caseInsensitive)

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    private func handleUtterance(_ text: String, forward: Bool) {
        if permission != nil {
            if Self.matches(Self.yes, text) { answerPermission(allow: true); return }
            if Self.matches(Self.no, text) { answerPermission(allow: false); return }
        }
        if forward, sendToThread(text) { waitingForClaude = true }
    }

    /// Sends what the user said; typed context rides along with it.
    @discardableResult
    func sendToThread(_ text: String) -> Bool {
        var msg = text
        let ctx = contextText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !ctx.isEmpty { msg += "\n\n(Typed context from the user: \(ctx))" }
        guard channel.send(["type": "user", "text": msg]) else {
            note = Note(text: "Not connected to a Claude Code thread. Pick a session.", kind: .error)
            return false
        }
        if !ctx.isEmpty { contextText = "" }
        record(.sent, msg)
        return true
    }

    /// Typed message sent on its own (the keyboard's send button).
    func sendTyped() {
        let text = contextText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard channel.send(["type": "user", "text": text]) else {
            note = Note(text: "Not connected to a Claude Code thread. Pick a session.", kind: .error)
            return
        }
        contextText = ""
        record(.sent, text)
        caption = Caption(role: .user, text: text, partial: false)
        waitingForClaude = true
    }

    // MARK: message history (per thread, like the Mac app's history panel)

    private var threadKey: String? { lastSessionKey }

    private func record(_ dir: HistoryEntry.Dir, _ text: String, kind: HistoryEntry.Kind = .message) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let thread = threadKey else { return }
        historyStore.add(HistoryEntry(dir: dir, kind: kind, text: t, at: Date(), thread: thread,
                                      pending: dir == .sent && kind == .message))
        refreshHistory()
    }

    private func refreshHistory() { history = historyStore.entries(for: threadKey) }

    func clearHistory() {
        historyStore.clear(thread: threadKey)
        refreshHistory()
    }

    // MARK: mode (GPT-Realtime reads Claude verbatim <-> GPT-Live full duplex), like the Mac's mode button

    func toggleMode() {
        var next = settings
        next.engine = settings.engine == .live ? .realtime : .live
        stopSpeaking()
        save(next)   // reopens the mic with the other pipeline if it was on
    }

    // MARK: permission prompts relayed from Claude Code

    private func permissionRequested(_ req: PermissionRequest) {
        permission = req
        permissionAnswer = nil
        record(.received, "Permission to use \(req.toolName): \(req.description)", kind: .permission)
        let desc = req.description.count > 160 ? "\(req.description.prefix(160))…" : req.description
        let line = "I need permission to use \(req.toolName): \(desc). Should I go ahead? Say yes or no."
        if settings.engine == .live { live.say(line) } else { speaker.say(line) }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    func answerPermission(allow: Bool) {
        guard let req = permission else { return }
        channel.send(["type": "permission", "request_id": req.requestID, "behavior": allow ? "allow" : "deny"])
        permissionAnswer = allow ? "✓ Allowed" : "✕ Denied"
        record(.sent, allow ? "Allowed" : "Denied", kind: .permission)
        waitingForClaude = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard self?.permission == req else { return }
            self?.permission = nil
            self?.permissionAnswer = nil
        }
    }

    // MARK: sub-agents

    private func agentUpdated(_ a: Agent) {
        if let i = agents.firstIndex(where: { $0.id == a.id }) { agents[i].merge(a) }
        else {
            var a = a
            a.log = (earlyLogs.removeValue(forKey: a.id) ?? []) + a.log
            agents.insert(a, at: 0)
            // A new sub-agent pops the panel open so the user can watch it.
            if a.running { showAgents = true }
        }
    }

    func stopAgent(_ id: String) { channel.send(["type": "agent_stop", "id": id]) }

    /// Start a sub-agent in the connected thread, as if Claude had called spawn_agent.
    func spawnAgent(task: String, name: String, mode: String) -> Bool {
        let task = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return false }
        var msg: [String: Any] = ["type": "agent_spawn", "task": task, "permission_mode": mode]
        let name = name.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty { msg["name"] = name }
        return channel.send(msg)
    }

    /// Follow-up for a finished or stopped sub-agent; it continues with its full context.
    func messageAgent(_ id: String, _ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        return channel.send(["type": "agent_message", "id": id, "text": text])
    }

    // MARK: threads (Claude Code sessions on paired Macs)

    /// Any live session on the Mac can open or end threads there; prefer the one we're talking to.
    private func controlSession(on macID: String) -> SessionInfo? {
        if let s = channel.session, s.macID == macID, connected { return s }
        return discovery.sessions.first { $0.macID == macID }
    }

    /// Open a new thread on the Mac (a Terminal window running claude with the voice channel) and switch to it.
    func newThread(on mac: PairedMac, cwd: String, prompt: String) async -> (ok: Bool, text: String) {
        guard let token = mac.token else { return (false, "\(mac.name) isn't paired.") }
        guard let via = controlSession(on: mac.id) else {
            return (false, "No thread is running on \(mac.name). Start one there with claude-voice first; after that you can open more from here.")
        }
        var msg: [String: Any] = ["type": "thread_new"]
        let cwd = cwd.trimmingCharacters(in: .whitespaces), prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cwd.isEmpty { msg["cwd"] = cwd }
        if !prompt.isEmpty { msg["prompt"] = prompt }
        let since = Date()
        let r = await ThreadControl.send(msg, via: via, token: token)
        if r.ok {
            pendingThread = (mac.id, since.addingTimeInterval(-2))
            note = Note(text: "\(r.text) Switching to it once it's up.", kind: .info)
        }
        return r
    }

    /// End a thread: its Claude Code session exits on the Mac.
    func endThread(_ s: SessionInfo) async -> (ok: Bool, text: String) {
        guard let token = pairedMacs.first(where: { $0.id == s.macID })?.token else { return (false, "\(s.machine) isn't paired.") }
        let via = discovery.sessions.first { $0.macID == s.macID && $0.id != s.id } ?? s
        let r = await ThreadControl.send(["type": "thread_end", "port": s.port], via: via, token: token)
        if r.ok, channel.session?.id == s.id { disconnect() }
        return r
    }

    // MARK: settings

    func save(_ next: Settings) {
        let prev = settings
        settings = next
        next.save()
        speaker.settings = next
        if [prev.voice, prev.realtimeModel, prev.openaiKey, prev.language] != [next.voice, next.realtimeModel, next.openaiKey, next.language] {
            speaker.reset()
        }
        let inputChanged = prev.sttModel != next.sttModel || prev.language != next.language || prev.silenceMs != next.silenceMs
            || prev.openaiKey != next.openaiKey || prev.engine != next.engine || prev.liveModel != next.liveModel || prev.voice != next.voice
        if inputChanged && listening {
            stopListening()
            startListening()
        } else if !listening && connected && hasKey && prev.openaiKey.isEmpty {
            startListening()
        }
        speaker.warmUp()
    }

    func testVoice() {
        if settings.engine == .live {
            if listening { live.say("Hi! This is how I'll sound when we talk.") }
            else { note = Note(text: "With GPT-Live, turn the mic on to hear the voice.", kind: .warn) }
        } else {
            speaker.say("Hi! This is how I'll sound when I talk to you.")
        }
    }

    // MARK: status line

    var status: String {
        if !connected { return channel.state == .connecting ? "Connecting…" : "Not connected — pick a session" }
        if needsAttach { return "Waiting for /voice phone in that session" }
        if permission != nil && permissionAnswer == nil { return "Say “yes” or “no”" }
        if speaking { return fullDuplex ? "Speaking… (just talk to interrupt)" : "Speaking… (tap to interrupt)" }
        if waitingForClaude { return "Claude is working…" }
        if listening { return settings.engine == .live ? "Live — just talk" : "Listening…" }
        return "Mic off — tap the orb"
    }

    func dismissNote() { note = nil }

    func appBecameActive() {
        channel.reconnectIfNeeded()
        discovery.start()
    }
}
