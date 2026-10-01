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
    @Published var showAgents = false
    @Published var contextText = ""

    let channel = ChannelClient()
    let discovery = Discovery()
    let audio = AudioIO()
    var meter: Meter { audio.meter }

    private let transcriber = Transcriber()
    private let speaker = Speaker()
    private lazy var live = LiveSession(meter: audio.meter)
    private var starting = false
    private var loudFrames = 0
    private var assistantFull: [Int: String] = [:]
    private var userBubble: String?          // stt item currently shown
    private var lastSessionKey: String? = UserDefaults.standard.string(forKey: "lastSession")

    var connected: Bool { channel.state == .connected }
    var hasKey: Bool { !settings.openaiKey.isEmpty }
    /// GPT-Live is built for full duplex; the other engines only if "interrupt by talking" is on.
    var fullDuplex: Bool { settings.engine == .live || settings.bargeIn }
    var runningAgents: Int { agents.filter(\.running).count }

    init() {
        speaker.settings = settings
        wire()
    }

    // MARK: wiring

    private func wire() {
        channel.onStateChange = { [weak self] state, reason in self?.channelChanged(state, reason) }
        channel.onSpeak = { [weak self] text in
            guard let self else { return }
            if self.settings.engine == .live { self.live.relay(text) } else { self.speaker.say(text) }
        }
        channel.onPermission = { [weak self] req in self?.permissionRequested(req) }
        channel.onAgents = { [weak self] list in self?.agents = list.sorted { $0.startedAt > $1.startedAt } }
        channel.onAgent = { [weak self] a in self?.agentUpdated(a) }
        channel.onAgentLog = { [weak self] id, line in
            guard let self, let i = self.agents.firstIndex(where: { $0.id == id }) else { return }
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
            note = Note(text: "Attached to the Claude Code thread in \(channel.cwd)", kind: .info)
            if !listening && hasKey { startListening() }
        case .disconnected:
            waitingForClaude = false
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
        if speaking || speaker.isBusy { stopSpeaking() } else { toggleMic() }
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
        if speaking && fullDuplex { detectBargeIn(peak) } else { loudFrames = 0 }
        // Half-duplex: send silence while Claude talks so transcription can't hear it.
        transcriber.append(speaking && !fullDuplex ? Data(count: pcm.count) : pcm)
    }

    /// Local barge-in: cut our buffered audio the moment the user clearly talks over Claude (~200 ms loud).
    private func detectBargeIn(_ level: Float) {
        loudFrames = level > 0.18 ? loudFrames + 1 : 0
        if loudFrames >= 2 { loudFrames = 0; interrupt() }
    }

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
            if speaking && fullDuplex { interrupt() }
            userBubble = id
            caption = Caption(role: .user, text: "…", partial: true)
        case .speechStopped(let id):
            // Noise that never produces a transcript: drop the placeholder.
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, self.userBubble == id, self.caption?.text == "…" else { return }
                self.caption = nil
            }
        case .delta(let id, let text):
            if speaking && fullDuplex { interrupt() }
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
        caption = Caption(role: .user, text: text, partial: false)
        waitingForClaude = true
    }

    // MARK: permission prompts relayed from Claude Code

    private func permissionRequested(_ req: PermissionRequest) {
        permission = req
        permissionAnswer = nil
        let desc = req.description.count > 160 ? "\(req.description.prefix(160))…" : req.description
        let line = "I need permission to use \(req.toolName): \(desc). Should I go ahead? Say yes or no."
        if settings.engine == .live { live.say(line) } else { speaker.say(line) }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    func answerPermission(allow: Bool) {
        guard let req = permission else { return }
        channel.send(["type": "permission", "request_id": req.requestID, "behavior": allow ? "allow" : "deny"])
        permissionAnswer = allow ? "✓ Allowed" : "✕ Denied"
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
            agents.insert(a, at: 0)
            // A new sub-agent pops the panel open so the user can watch it.
            if a.running { showAgents = true }
        }
    }

    func stopAgent(_ id: String) { channel.send(["type": "agent_stop", "id": id]) }

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
