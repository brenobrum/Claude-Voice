import Foundation
import Network

/// A live Claude Code session, announced by its voice channel over Bonjour (_claudevoice._tcp).
struct SessionInfo: Identifiable, Hashable {
    let id: String        // Bonjour instance name
    let project: String
    let cwd: String
    let host: String      // e.g. MacBook-Pro.local
    let machine: String
    let port: Int
    let started: Date?

    var macID: String { host.lowercased() }
}

/// Browses the local network for voice channels. Starting it also triggers iOS's local-network prompt.
@MainActor
final class Discovery: ObservableObject {
    @Published private(set) var sessions: [SessionInfo] = []
    @Published private(set) var error: String?
    private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_claudevoice._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let found = results.compactMap(Self.session(from:))
            Task { @MainActor in
                self?.sessions = found.sorted { ($0.started ?? .distantPast) > ($1.started ?? .distantPast) }
            }
        }
        b.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .failed(let err), .waiting(let err):
                    self?.error = "Local network: \(err.localizedDescription). Allow Claude Voice in Settings → Privacy & Security → Local Network."
                case .ready:
                    self?.error = nil
                default: break
                }
            }
        }
        b.start(queue: .main)
        browser = b
    }

    func restart() {
        browser?.cancel()
        browser = nil
        start()
    }

    private nonisolated static func session(from r: NWBrowser.Result) -> SessionInfo? {
        guard case let .service(name, _, _, _) = r.endpoint,
              case let .bonjour(txt) = r.metadata else { return nil }
        let d = txt.dictionary
        guard let host = d["host"], let port = d["port"].flatMap(Int.init) else { return nil }
        let started = d["started"].flatMap(Double.init).map { Date(timeIntervalSince1970: $0 / 1000) }
        return SessionInfo(id: name, project: d["project"] ?? name, cwd: d["cwd"] ?? "", host: host,
                           machine: d["machine"] ?? host, port: port, started: started)
    }
}
