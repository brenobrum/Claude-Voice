import Foundation

/// One line of the message history (same shape as the Mac app's history panel).
struct HistoryEntry: Codable, Identifiable, Equatable {
    var id = UUID()
    let dir: Dir
    let kind: Kind
    let text: String
    let at: Date
    let thread: String
    var pending = false   // sent, and the thread hasn't gone idle since

    enum Dir: String, Codable { case sent, received }
    enum Kind: String, Codable { case message, permission }
}

/// Message history per Claude Code thread, kept in Application Support.
final class HistoryStore {
    private(set) var all: [HistoryEntry] = []
    private static let max = 500
    private let file: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("history.json")
    }()

    init() {
        if let data = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([HistoryEntry].self, from: data) {
            all = list.map { var e = $0; e.pending = false; return e } // nothing is in flight after a restart
        }
    }

    func entries(for thread: String?) -> [HistoryEntry] { all.filter { $0.thread == thread } }

    func add(_ e: HistoryEntry) {
        all.append(e)
        if all.count > Self.max { all.removeFirst(all.count - Self.max) }
        save()
    }

    /// Sent messages stop showing as "processing" once the thread goes idle.
    func settle() {
        guard all.contains(where: \.pending) else { return }
        for i in all.indices { all[i].pending = false }
        save()
    }

    func clear(thread: String?) {
        all.removeAll { $0.thread == thread }
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(all) { try? data.write(to: file, options: .atomic) }
    }
}
