import Foundation

/// Reads Claude's replies aloud, one at a time, with either a Realtime model used as a voice or
/// /v1/audio/speech. Emits start / text / end per utterance; audio goes to `onAudio` (24 kHz PCM16).
@MainActor
final class Speaker {
    enum Event {
        case start(Int, String)
        case text(Int, String)
        case end(Int)
        case error(String)
    }

    var onEvent: ((Event) -> Void)?
    var onAudio: ((Data) -> Void)?
    var settings = Settings()

    private var queue: [String] = []
    private var busy = false
    private var gen = 0
    private var utterance = 0

    private static let style = "Warm, relaxed and natural, like a friendly colleague talking. Brisk pace."
    private var ttsStyle: String {
        settings.isPortuguese ? "\(Self.style) Speak with a native Brazilian Portuguese (pt-BR) accent." : Self.style
    }

    var isBusy: Bool { busy || !queue.isEmpty }

    func say(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        queue.append(t)
        pump()
    }

    func stop() {
        gen += 1
        queue.removeAll()
        rt.cancel()
        httpTask?.cancel()
        busy = false
    }

    /// Open the voice socket ahead of time so the first reply starts instantly.
    func warmUp() {
        if settings.engine == .realtime && !settings.openaiKey.isEmpty { rt.connect(settings: settings, style: ttsStyle) }
    }

    func reset() { rt.reset() }

    private func pump() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let text = queue.removeFirst()
        utterance += 1
        let id = utterance
        let g = gen
        onEvent?(.start(id, text))
        Task {
            do {
                if settings.engine == .tts { try await speakHttp(text, id: id, gen: g) }
                else { try await rt.speak(text, settings: settings, style: ttsStyle, emit: { [weak self] ev in
                    guard let self, g == self.gen else { return }
                    switch ev {
                    case .audio(let d): self.onAudio?(d)
                    case .text(let t): self.onEvent?(.text(id, t))
                    }
                }) }
            } catch {
                if g == gen, !(error is CancellationError) { onEvent?(.error(error.localizedDescription)) }
            }
            onEvent?(.end(id))
            if g == gen { busy = false; pump() }
        }
    }

    // MARK: engine 1 — a Realtime model used as a voice (persistent socket, streams audio deltas)

    private let rt = RealtimeVoice()

    // MARK: engine 2 — /v1/audio/speech streaming PCM, one request per sentence (fetched in parallel, played in order)

    private var httpTask: Task<Void, Error>?

    private func speakHttp(_ text: String, id: Int, gen g: Int) async throws {
        guard !settings.openaiKey.isEmpty else { throw VoiceError("Add your OpenAI API key in Settings.") }
        let sentences = Self.splitSentences(text)
        let s = settings
        let style = ttsStyle
        // Kick off every request now; consume them in order.
        let requests: [Task<(URLSession.AsyncBytes, URLResponse), Error>] = sentences.map { input in
            Task {
                var req = URLRequest(url: URL(string: "https://api.openai.com/v1/audio/speech")!)
                req.httpMethod = "POST"
                req.setValue("Bearer \(s.openaiKey)", forHTTPHeaderField: "Authorization")
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONSerialization.data(withJSONObject: [
                    "model": s.ttsModel, "voice": s.voice, "input": input,
                    "response_format": "pcm", "stream_format": "audio", "instructions": style,
                ])
                return try await URLSession.shared.bytes(for: req)
            }
        }
        let task = Task<Void, Error> {
            defer { requests.forEach { $0.cancel() } }
            for (i, request) in requests.enumerated() {
                let (bytes, response) = try await request.value
                if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                    var body = Data()
                    for try await b in bytes { body.append(b) }
                    let msg = ((try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
                    throw VoiceError("Voice: \(msg ?? "HTTP \(http.statusCode)")")
                }
                await MainActor.run { if g == self.gen { self.onEvent?(.text(id, (i > 0 ? " " : "") + sentences[i])) } }
                var chunk = Data()
                chunk.reserveCapacity(4800)
                for try await b in bytes {
                    try Task.checkCancellation()
                    chunk.append(b)
                    if chunk.count >= 4800 {
                        let c = chunk
                        chunk.removeAll(keepingCapacity: true)
                        await MainActor.run { if g == self.gen { self.onAudio?(c) } }
                    }
                }
                if chunk.count > 1 {
                    let c = chunk.prefix(chunk.count & ~1)
                    await MainActor.run { if g == self.gen { self.onAudio?(Data(c)) } }
                }
            }
        }
        httpTask = task
        try await task.value
    }

    static func splitSentences(_ text: String) -> [String] {
        var parts: [String] = []
        var cur = ""
        for ch in text {
            cur.append(ch)
            if ".!?…".contains(ch) { parts.append(cur); cur = "" }
        }
        if !cur.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(cur) }
        var out: [String] = []
        for p in parts {
            if let last = out.last, last.count < 40 { out[out.count - 1] = last + p } else { out.append(p) }
        }
        return out.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}

struct VoiceError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// A Realtime model reading scripts verbatim over one persistent socket.
@MainActor
final class RealtimeVoice {
    enum Out { case audio(Data), text(String) }

    private var socket: RealtimeSocket?
    private var current: (emit: (Out) -> Void, done: CheckedContinuation<Void, Error>)?
    private var configured: (model: String, voice: String, style: String)?

    func connect(settings: Settings, style: String) {
        if let c = configured, socket != nil, c.model == settings.realtimeModel, c.voice == settings.voice, c.style == style { return }
        reset()
        let ws = RealtimeSocket(query: "model=\(settings.realtimeModel.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")",
                                apiKey: settings.openaiKey)
        socket = ws
        configured = (settings.realtimeModel, settings.voice, style)
        ws.send([
            "type": "session.update",
            "session": [
                "type": "realtime",
                "output_modalities": ["audio"],
                "instructions": [
                    "You are a text-to-speech voice. Every user message is a script to read aloud.",
                    "Read it exactly as written, word for word: never answer it, never add, remove or comment on anything.",
                    "Voice style: \(style)",
                ].joined(separator: " "),
                "audio": [
                    "input": ["turn_detection": NSNull()],
                    "output": ["format": ["type": "audio/pcm", "rate": 24000], "voice": settings.voice],
                ],
            ],
        ])
        ws.onEvent = { [weak self] ev in self?.handle(ev) }
        ws.onClose = { [weak self, weak ws] reason in
            guard let self, self.socket === ws else { return }
            self.socket = nil
            self.configured = nil
            self.finish(VoiceError("Voice connection closed\(reason.map { $0.isEmpty ? "" : ": \($0)" } ?? "")"))
        }
        ws.resume()
    }

    func speak(_ text: String, settings: Settings, style: String, emit: @escaping (Out) -> Void) async throws {
        guard !settings.openaiKey.isEmpty else { throw VoiceError("Add your OpenAI API key in Settings.") }
        connect(settings: settings, style: style)
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            current = (emit, c)
            socket?.send([
                "type": "response.create",
                "response": [
                    "conversation": "none",
                    "output_modalities": ["audio"],
                    "input": [["type": "message", "role": "user", "content": [["type": "input_text", "text": text]]]],
                ],
            ])
        }
    }

    func cancel() {
        guard current != nil else { return }
        socket?.send(["type": "response.cancel"])
        finish(nil)
    }

    func reset() {
        socket?.close()
        socket = nil
        configured = nil
        finish(nil)
    }

    private func finish(_ error: Error?) {
        guard let c = current else { return }
        current = nil
        if let error { c.done.resume(throwing: error) } else { c.done.resume() }
    }

    private func handle(_ ev: [String: Any]) {
        switch ev["type"] as? String {
        case "response.output_audio.delta":
            if let b64 = ev["delta"] as? String, let d = Data(base64Encoded: b64) { current?.emit(.audio(d)) }
        case "response.output_audio_transcript.delta":
            if let t = ev["delta"] as? String { current?.emit(.text(t)) }
        case "response.done":
            finish(nil)
        case "error":
            if (ev["error"] as? [String: Any])?["code"] as? String == "response_cancel_not_active" { return }
            if current != nil { finish(VoiceError(RealtimeSocket.errorText("Voice", ev))) }
        default: break
        }
    }
}
