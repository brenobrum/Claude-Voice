import AVFoundation
import Foundation
import WebRTC

/// GPT-Live over WebRTC (same transport as the Mac app): full duplex conversation in which GPT-Live
/// delegates every real request to Claude (client delegation) and then says Claude's answer.
@MainActor
final class LiveSession: NSObject {
    enum Event {
        case open
        case userDelta(String, String)        // bubble id, text
        case userFinal(String)
        case assistantStart(String)
        case assistantDelta(String, String)
        case assistantEnd(String)
        case delegate(String)                 // user's words to hand to Claude
        case speaking(Bool)
        case error(String)
        case closed(String?)
    }

    var onEvent: ((Event) -> Void)?
    let meter: Meter

    private static let instructions = """
    You are the voice of Claude Code, an AI coding agent working in the user's software project on their computer.
    You cannot see the project, run commands, or know anything about it yourself: the backend (Claude) does all real work.
    - Delegate every request, question or instruction to the backend, except pure small talk like greetings or "thanks".
    - While waiting, you may say one very short natural filler ("Let me check."), then stay quiet until the result arrives.
    - When a result arrives, say it naturally and faithfully: keep every fact, name, number and decision; don't add your own claims.
    - If the user adds or corrects details while the backend is working, delegate again with the new information.
    - Always speak in the language the user is speaking. Keep it brief and conversational.
    """

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    private var pc: RTCPeerConnection?
    private var dc: RTCDataChannel?
    private var remoteTrack: RTCAudioTrack?
    private var statsTimer: Timer?
    private var duckWork: DispatchWorkItem?
    private var gatherWaiter: CheckedContinuation<Void, Never>?

    private(set) var active = false
    private(set) var started = false
    private var inputText = ""
    private var delegationID: String?
    private var inID = 0, outID = 0
    private var side: String?        // "user" | "assistant" — bubble grouping
    private var outIdle: DispatchWorkItem?
    private var speaking = false
    private var lastVoiced = Date.distantPast

    init(meter: Meter) { self.meter = meter }

    // MARK: lifecycle

    func open(settings: Settings) {
        guard !active else { return }
        guard !settings.openaiKey.isEmpty else { onEvent?(.error("Add your OpenAI API key in Settings.")); onEvent?(.closed(nil)); return }
        active = true
        started = false
        Task { await connect(settings) }
    }

    func close() {
        guard active else { return }
        active = false
        started = false
        inputText = ""
        endOutput()
        send(["type": "session.close"])
        let p = pc
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            if self?.pc === p { self?.teardown(nil, quiet: true) }
        }
    }

    private func configureAudioSession() {
        let s = RTCAudioSession.sharedInstance()
        s.lockForConfiguration()
        defer { s.unlockForConfiguration() }
        try? s.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try? s.setActive(true)
    }

    private func connect(_ settings: Settings) async {
        configureAudioSession()
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        guard let pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            teardown("could not create a WebRTC connection"); return
        }
        self.pc = pc
        let source = Self.factory.audioSource(with: constraints)
        let track = Self.factory.audioTrack(with: source, trackId: "mic")
        pc.add(track, streamIds: ["mic"])
        // The event channel must exist before the offer is created.
        let dc = pc.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
        dc?.delegate = self
        self.dc = dc

        do {
            let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { c in
                pc.offer(for: constraints) { sdp, err in
                    if let sdp { c.resume(returning: sdp) } else { c.resume(throwing: err ?? VoiceError("no SDP offer")) }
                }
            }
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                pc.setLocalDescription(offer) { err in if let err { c.resume(throwing: err) } else { c.resume() } }
            }
            // Host candidates are enough; don't wait forever on STUN.
            if pc.iceGatheringState != .complete {
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    gatherWaiter = c
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.gathered() }
                }
            }
            guard self.pc === pc, let local = pc.localDescription else { return }
            let answer = try await createSession(local.sdp, settings: settings)
            guard self.pc === pc else { return }
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer)) { err in
                    if let err { c.resume(throwing: err) } else { c.resume() }
                }
            }
            startStats()
        } catch {
            onEvent?(.error(error.localizedDescription))
            if self.pc === pc { teardown("") }
        }
    }

    private func gathered() {
        let w = gatherWaiter
        gatherWaiter = nil
        w?.resume()
    }

    /// Exchange our SDP offer for OpenAI's answer. This HTTP request starts the session.
    private func createSession(_ sdp: String, settings: Settings) async throws -> String {
        var req = URLRequest(url: URL(string: "https://api.openai.com/v1/live/sessions")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(settings.openaiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let instructions = settings.isPortuguese
            ? "\(Self.instructions)\n- Default to Brazilian Portuguese (pt-BR) with a native Brazilian accent."
            : Self.instructions
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "session": [
                "model": settings.liveModel,
                "instructions": instructions,
                "audio": ["output": ["voice": settings.voice]],
                "delegation": ["type": "client"],
            ],
            "transport": ["type": "webrtc", "sdp": sdp],
        ])
        let (data, res) = try await URLSession.shared.data(for: req)
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let http = res as? HTTPURLResponse, http.statusCode >= 400 {
            let msg = (json?["error"] as? [String: Any])?["message"] as? String
            throw VoiceError("GPT-Live: \(msg ?? "HTTP \(http.statusCode)")")
        }
        guard let answer = (json?["transport"] as? [String: Any])?["sdp"] as? String else { throw VoiceError("GPT-Live: no SDP answer") }
        return answer
    }

    private func teardown(_ reason: String?, quiet: Bool = false) {
        let p = pc
        pc = nil
        dc = nil
        remoteTrack = nil
        statsTimer?.invalidate()
        statsTimer = nil
        p?.close()
        gathered()
        setSpeaking(false)
        meter.mic = 0
        meter.out = 0
        meter.micActive = false
        if !quiet { handle(["type": "transport.closed", "reason": reason ?? ""]) }
    }

    private func send(_ ev: [String: Any]) {
        guard let dc, dc.readyState == .open, let data = try? JSONSerialization.data(withJSONObject: ev) else { return }
        dc.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    // MARK: Claude <-> GPT-Live

    /// Claude's reply (speak tool) -> GPT-Live says it. Appends are limited to ~500 tokens.
    func relay(_ text: String) {
        guard started else { onEvent?(.error("GPT-Live is not running; turn the mic on.")); return }
        for chunk in Self.chunks(text, size: 1500) {
            send(["type": "session.commentary.append", "delegation_id": delegationID.map { $0 as Any } ?? NSNull(),"content": chunk])
        }
    }

    func say(_ text: String) {
        guard started else { return }
        send(["type": "session.instructions.append", "delegation_id": NSNull(), "content": "Say this to the user now, then listen: \(text)"])
    }

    /// Local barge-in: silence what's already buffered right away; GPT-Live stops on its own.
    func duck(_ seconds: TimeInterval) {
        guard let remoteTrack else { return }
        remoteTrack.isEnabled = false
        duckWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.remoteTrack?.isEnabled = true }
        duckWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
    }

    private static func chunks(_ text: String, size: Int) -> [String] {
        var out: [String] = []
        var cur = ""
        for word in text.split(separator: " ", omittingEmptySubsequences: false) {
            if cur.count + word.count + 1 > size, !cur.isEmpty { out.append(cur); cur = "" }
            cur += cur.isEmpty ? String(word) : " \(word)"
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    private func handle(_ ev: [String: Any]) {
        switch ev["type"] as? String {
        case "session.started":
            started = true
            meter.micActive = true
            onEvent?(.open)
        case "session.input_transcript.delta":
            if side != "user" { endOutput(); side = "user"; inID += 1 }
            let d = ev["delta"] as? String ?? ""
            inputText += d
            onEvent?(.userDelta("live-in-\(inID)", d))
        case "session.output_transcript.delta":
            if side != "assistant" {
                finishInput()
                side = "assistant"
                outID += 1
                onEvent?(.assistantStart("live-out-\(outID)"))
            }
            onEvent?(.assistantDelta("live-out-\(outID)", ev["delta"] as? String ?? ""))
            outIdle?.cancel()
            let w = DispatchWorkItem { [weak self] in self?.endOutput() }
            outIdle = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
        case "session.delegation.created":
            delegationID = (ev["delegation"] as? [String: Any])?["id"] as? String
            // The event carries no text; the transcript may lag the delegation slightly.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.forwardToClaude() }
        case "error":
            onEvent?(.error(RealtimeSocket.errorText("GPT-Live", ev)))
        case "transport.closed":
            guard active else { return }
            active = false
            started = false
            endOutput()
            let r = ev["reason"] as? String ?? ""
            onEvent?(.closed(r.isEmpty ? nil : r))
        default: break
        }
    }

    private func finishInput() {
        if side == "user" { onEvent?(.userFinal("live-in-\(inID)")) }
    }

    private func endOutput() {
        outIdle?.cancel()
        if side == "assistant" { onEvent?(.assistantEnd("live-out-\(outID)")); side = nil }
    }

    private func forwardToClaude() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        inputText = ""
        guard !text.isEmpty else { return }
        finishInput()
        side = nil
        onEvent?(.delegate(text))
    }

    // MARK: levels (for the orb and to know when Claude is audibly speaking)

    private func startStats() {
        statsTimer?.invalidate()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            self?.pc?.statistics { report in
                var mic: Double?, out: Double?
                for s in report.statistics.values where (s.values["kind"] as? String) == "audio" {
                    let level = (s.values["audioLevel"] as? NSNumber)?.doubleValue
                    if s.type == "media-source" { mic = level } else if s.type == "inbound-rtp" { out = level }
                }
                Task { @MainActor in self?.levels(mic: mic, out: out) }
            }
        }
    }

    private func levels(mic: Double?, out: Double?) {
        if let mic { meter.mic = Float(mic) * 0.6 }
        if let out {
            meter.out = Float(out) * 0.5
            if out > 0.01 { lastVoiced = Date(); setSpeaking(true) }
        }
        if speaking && Date().timeIntervalSince(lastVoiced) > 0.4 { setSpeaking(false) }
    }

    private func setSpeaking(_ on: Bool) {
        guard on != speaking else { return }
        speaking = on
        onEvent?(.speaking(on))
    }
}

extension LiveSession: RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        guard newState == .complete else { return }
        Task { @MainActor in if self.pc === peerConnection { self.gathered() } }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        guard newState == .failed || newState == .closed else { return }
        Task { @MainActor in
            if self.pc === peerConnection { self.teardown("WebRTC \(newState == .failed ? "failed" : "closed")") }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
        guard let track = transceiver.receiver.track as? RTCAudioTrack else { return }
        Task { @MainActor in if self.pc === peerConnection { self.remoteTrack = track } }
    }

    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        guard dataChannel.readyState == .closed else { return }
        Task { @MainActor in if self.dc === dataChannel { self.teardown("connection closed") } }
    }

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let ev = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
        Task { @MainActor in if self.dc === dataChannel { self.handle(ev) } }
    }
}
