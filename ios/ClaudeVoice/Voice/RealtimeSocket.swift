import Foundation

/// A JSON-event WebSocket to the OpenAI Realtime API (wss://api.openai.com/v1/realtime?…).
/// Callbacks run on the main queue.
final class RealtimeSocket {
    var onOpen: (() -> Void)?
    var onEvent: (([String: Any]) -> Void)?
    var onClose: ((String?) -> Void)?   // nil = closed normally

    private var task: URLSessionWebSocketTask?
    private(set) var isOpen = false

    init(query: String, apiKey: String) {
        var req = URLRequest(url: URL(string: "wss://api.openai.com/v1/realtime?\(query)")!)
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        task = URLSession.shared.webSocketTask(with: req)
    }

    func resume() {
        guard let task else { return }
        task.resume()
        receive(task)
    }

    func send(_ event: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: event),
              let s = String(data: data, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }

    func close() {
        let t = task
        task = nil
        isOpen = false
        t?.cancel(with: .normalClosure, reason: nil)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.task === t else { return }
                switch result {
                case .success(let msg):
                    var data: Data?
                    if case .string(let s) = msg { data = s.data(using: .utf8) } else if case .data(let d) = msg { data = d }
                    if let data, let ev = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        if !self.isOpen { self.isOpen = true; self.onOpen?() }
                        self.onEvent?(ev)
                    }
                    self.receive(t)
                case .failure(let err):
                    self.task = nil
                    self.isOpen = false
                    self.onClose?(Self.explain(t, err))
                }
            }
        }
    }

    /// Surface why OpenAI refused the socket (bad key, no access, unknown model).
    private static func explain(_ t: URLSessionWebSocketTask, _ err: Error) -> String {
        if let http = t.response as? HTTPURLResponse, http.statusCode >= 400 {
            switch http.statusCode {
            case 401: return "HTTP 401 — the OpenAI API key was rejected"
            case 403: return "HTTP 403 — this key has no access to that model"
            case 404: return "HTTP 404 — unknown model"
            default: return "HTTP \(http.statusCode)"
            }
        }
        if t.closeCode != .invalid {
            let reason = t.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            return t.closeCode == .normalClosure ? "" : "\(t.closeCode.rawValue) \(reason)"
        }
        return err.localizedDescription
    }

    static func errorText(_ prefix: String, _ ev: [String: Any]) -> String {
        let e = ev["error"] as? [String: Any] ?? [:]
        return "\(prefix): \(e["message"] as? String ?? e["code"] as? String ?? "unknown error")"
    }
}
