import Foundation

/// Speech-to-text over a Realtime transcription session (server VAD decides when a turn ends).
final class Transcriber {
    enum Event {
        case open
        case speechStarted(String)
        case speechStopped(String)
        case delta(String, String)       // item id, text
        case final(String, String)       // item id, transcript
        case closed(String?)
        case error(String)
    }

    var onEvent: ((Event) -> Void)?
    private var socket: RealtimeSocket?

    var isOpen: Bool { socket != nil }

    func open(settings: Settings) {
        guard socket == nil else { return }
        let ws = RealtimeSocket(query: "intent=transcription", apiKey: settings.openaiKey)
        socket = ws
        var transcription: [String: Any] = ["model": settings.sttModel]
        if !settings.language.isEmpty { transcription["language"] = settings.language }
        ws.send([
            "type": "session.update",
            "session": [
                "type": "transcription",
                "audio": [
                    "input": [
                        "format": ["type": "audio/pcm", "rate": 24000],
                        "noise_reduction": ["type": "near_field"],
                        "transcription": transcription,
                        "turn_detection": [
                            "type": "server_vad",
                            "threshold": 0.5,
                            "prefix_padding_ms": 300,
                            "silence_duration_ms": settings.silenceMs,
                        ],
                    ],
                ],
            ],
        ])
        ws.onOpen = { [weak self] in self?.onEvent?(.open) }
        ws.onEvent = { [weak self] ev in self?.handle(ev) }
        ws.onClose = { [weak self, weak ws] reason in
            guard let self, self.socket === ws else { return }
            self.socket = nil
            self.onEvent?(.closed(reason?.isEmpty == false ? reason : nil))
        }
        ws.resume()
    }

    func close() {
        let ws = socket
        socket = nil
        ws?.close()
    }

    func append(_ pcm: Data) {
        guard let socket, socket.isOpen else { return }
        socket.send(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()])
    }

    func clear() {
        guard let socket, socket.isOpen else { return }
        socket.send(["type": "input_audio_buffer.clear"])
    }

    private func handle(_ ev: [String: Any]) {
        let id = ev["item_id"] as? String ?? ""
        switch ev["type"] as? String {
        case "input_audio_buffer.speech_started": onEvent?(.speechStarted(id))
        case "input_audio_buffer.speech_stopped": onEvent?(.speechStopped(id))
        case "conversation.item.input_audio_transcription.delta": onEvent?(.delta(id, ev["delta"] as? String ?? ""))
        case "conversation.item.input_audio_transcription.completed":
            onEvent?(.final(id, (ev["transcript"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)))
        case "conversation.item.input_audio_transcription.failed": onEvent?(.final(id, ""))
        case "error": onEvent?(.error(RealtimeSocket.errorText("Transcription", ev)))
        default: break
        }
    }
}
