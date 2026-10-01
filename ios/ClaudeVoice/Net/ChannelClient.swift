import Foundation

struct AgentLogLine: Identifiable, Hashable {
    let id = UUID()
    let kind: String   // prompt | text | tool | error | result
    let text: String
}

struct Agent: Identifiable, Hashable {
    let id: String
    var name: String
    var task: String
    var status: String          // running | done | failed | stopped
    var activity: String
    var startedAt: Date
    var endedAt: Date?
    var log: [AgentLogLine] = []

    var running: Bool { status == "running" }

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String else { return nil }
        self.id = id
        name = d["name"] as? String ?? id
        task = d["task"] as? String ?? ""
        status = d["status"] as? String ?? "running"
        activity = d["activity"] as? String ?? ""
        startedAt = Date(timeIntervalSince1970: (d["startedAt"] as? Double ?? Date().timeIntervalSince1970 * 1000) / 1000)
        endedAt = (d["endedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
        log = (d["log"] as? [[String: Any]] ?? []).compactMap(AgentLogLine.init)
    }

    mutating func merge(_ other: Agent) {
        name = other.name; task = other.task; status = other.status
        activity = other.activity; startedAt = other.startedAt; endedAt = other.endedAt
    }
}

extension AgentLogLine {
    init?(_ d: [String: Any]) {
        guard let text = d["text"] as? String else { return nil }
        self.init(kind: d["kind"] as? String ?? "text", text: text)
    }
}

/// What the Claude thread is doing, from Claude Code hooks (channel/server.js `activity`).
struct ClaudeActivity: Equatable {
    struct Background: Equatable { var label: String; var activity: String }
    var state = "idle"            // idle | thinking | tool
    var detail = ""               // the tool line, e.g. "Bash  npm test"
    var since = Date()
    var background: [Background] = []

    var busy: Bool { state != "idle" }
    var visible: Bool { busy || !background.isEmpty }

    init() {}

    init(_ d: [String: Any]) {
        state = d["state"] as? String ?? "idle"
        detail = d["detail"] as? String ?? ""
        since = (d["since"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
        background = (d["background"] as? [[String: Any]] ?? []).map {
            Background(label: $0["label"] as? String ?? "agent", activity: $0["activity"] as? String ?? "")
        }
    }
}

struct PermissionRequest: Equatable {
    let requestID: String
    let toolName: String
    let description: String
    let inputPreview: String
}

/// WebSocket link to one session's voice channel (channel/server.js), same protocol as the Mac app.
@MainActor
final class ChannelClient: ObservableObject {
    enum State: Equatable { case disconnected, connecting, connected }

    @Published private(set) var state: State = .disconnected
    @Published private(set) var session: SessionInfo?
    @Published private(set) var cwd = ""

    var onSpeak: ((String) -> Void)?
    var onPermission: ((PermissionRequest) -> Void)?
    var onAgents: (([Agent]) -> Void)?
    var onAgent: ((Agent) -> Void)?
    var onAgentLog: ((String, AgentLogLine) -> Void)?
    var onMonitor: ((_ count: Int, _ needed: Bool) -> Void)?
    var onNeedsAttach: (() -> Void)?
    var onActivity: ((ClaudeActivity) -> Void)?
    var onStateChange: ((State, String?) -> Void)?   // state, reason

    private var task: URLSessionWebSocketTask?
    private var token = ""
    private var retryWork: DispatchWorkItem?
    private var wantConnected = false
    private var retries = 0

    func connect(to session: SessionInfo, token: String) {
        disconnect()
        self.session = session
        self.token = token
        wantConnected = true
        retries = 0
        open()
    }

    func disconnect() {
        wantConnected = false
        retryWork?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session = nil
        setState(.disconnected, reason: nil)
    }

    /// Re-open after the app comes back to the foreground or the network changed.
    func reconnectIfNeeded() {
        guard wantConnected, state == .disconnected, session != nil else { return }
        retries = 0
        open()
    }

    @discardableResult
    func send(_ msg: [String: Any]) -> Bool {
        guard state == .connected, let task,
              let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return false }
        task.send(.string(text)) { _ in }
        return true
    }

    private func open() {
        guard let session else { return }
        var comps = URLComponents()
        comps.scheme = "ws"
        comps.host = session.host
        comps.port = session.port
        comps.path = "/"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url else { return }
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        setState(.connecting, reason: nil)
        t.resume()
        receive(on: t)
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === t else { return }
                switch result {
                case .success(let message):
                    if case .string(let s) = message { self.handle(s) }
                    else if case .data(let d) = message, let s = String(data: d, encoding: .utf8) { self.handle(s) }
                    self.receive(on: t)
                case .failure(let err):
                    self.dropped(t, reason: t.closeCode == .invalid ? err.localizedDescription : Self.describe(t))
                }
            }
        }
    }

    private static func describe(_ t: URLSessionWebSocketTask) -> String {
        if t.closeCode.rawValue == 4001 { return "the pairing token was rejected — pair again with claude-voice pair" }
        let reason = t.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return "closed (\(t.closeCode.rawValue)\(reason.isEmpty ? "" : " \(reason)"))"
    }

    private func dropped(_ t: URLSessionWebSocketTask, reason: String) {
        task = nil
        let wasConnected = state == .connected
        setState(.disconnected, reason: reason)
        // Wi-Fi blips and app suspension: retry a few times while the user still wants this session.
        guard wantConnected, t.closeCode.rawValue != 4001, retries < 5 || wasConnected else { return }
        retries = wasConnected ? 1 : retries + 1
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in if self?.wantConnected == true && self?.task == nil { self?.open() } }
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(min(retries, 4)) * 1.5, execute: work)
    }

    private func setState(_ s: State, reason: String?) {
        guard s != state else { return }
        state = s
        onStateChange?(s, reason)
    }

    private func handle(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["type"] as? String else { return }
        switch type {
        case "hello":
            cwd = msg["cwd"] as? String ?? ""
            retries = 0
            setState(.connected, reason: nil)
        case "speak":
            onSpeak?(msg["text"] as? String ?? "")
        case "permission_request":
            guard let id = msg["request_id"] as? String else { return }
            onPermission?(PermissionRequest(requestID: id, toolName: msg["tool_name"] as? String ?? "a tool",
                                            description: msg["description"] as? String ?? "",
                                            inputPreview: msg["input_preview"] as? String ?? ""))
        case "agents":
            onAgents?((msg["agents"] as? [[String: Any]] ?? []).compactMap(Agent.init))
        case "agent":
            if let d = msg["agent"] as? [String: Any], let a = Agent(d) { onAgent?(a) }
        case "agent_log":
            if let id = msg["id"] as? String, let d = msg["line"] as? [String: Any], let line = AgentLogLine(d) { onAgentLog?(id, line) }
        case "activity":
            if let d = msg["activity"] as? [String: Any] { onActivity?(ClaudeActivity(d)) }
        case "monitor":
            onMonitor?(msg["count"] as? Int ?? 0, msg["needed"] as? Bool ?? false)
        case "needs_attach":
            onNeedsAttach?()
        default: break
        }
    }
}

/// One-off request to any voice channel on a Mac (open / end a thread), without touching the voice connection:
/// connect, wait for the hello, send, and return the `thread_result` text.
enum ThreadControl {
    static func send(_ msg: [String: Any], via s: SessionInfo, token: String) async -> (ok: Bool, text: String) {
        var comps = URLComponents()
        comps.scheme = "ws"; comps.host = s.host; comps.port = s.port; comps.path = "/"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url, let data = try? JSONSerialization.data(withJSONObject: msg),
              let body = String(data: data, encoding: .utf8) else { return (false, "Bad request.") }
        let t = URLSession.shared.webSocketTask(with: url)
        t.resume()
        return await withTaskGroup(of: (Bool, String).self) { group in
            group.addTask {
                do {
                    var sent = false
                    while true {
                        guard case .string(let raw) = try await t.receive(),
                              let d = raw.data(using: .utf8),
                              let m = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
                        let type = m["type"] as? String
                        if type == "hello", !sent { sent = true; try await t.send(.string(body)) }
                        if type == "thread_result" { return (m["ok"] as? Bool ?? false, m["text"] as? String ?? "") }
                    }
                } catch { return (false, "Couldn't reach \(s.machine): \(error.localizedDescription)") }
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(8))
                return (false, "\(s.machine) didn't answer.")
            }
            let first = await group.next() ?? (false, "")
            // receive() doesn't honor task cancellation; closing the socket ends it.
            t.cancel(with: .normalClosure, reason: nil)
            group.cancelAll()
            return first
        }
    }
}
