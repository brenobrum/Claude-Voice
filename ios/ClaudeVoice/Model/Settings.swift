import Foundation

enum VoiceEngine: String, CaseIterable, Codable, Identifiable {
    case realtime   // Realtime transcription + gpt-realtime voice reading Claude verbatim
    case live       // GPT-Live full duplex; Claude is its delegated backend
    case tts        // Realtime transcription + /v1/audio/speech

    var id: String { rawValue }
    var label: String {
        switch self {
        case .realtime: "GPT-Realtime (reads Claude verbatim)"
        case .live: "GPT-Live (full duplex, paraphrases)"
        case .tts: "TTS (cheapest)"
        }
    }
}

/// Same knobs as the Mac app (minus the global hotkey). The API key lives in the Keychain.
struct Settings: Codable, Equatable {
    var engine: VoiceEngine = .realtime
    var liveModel = "gpt-live-1"
    var realtimeModel = "gpt-realtime-2"
    var ttsModel = "gpt-4o-mini-tts"
    var voice = "marin"
    var sttModel = "gpt-4o-transcribe"
    var language = "pt"           // Brazilian Portuguese by default
    var silenceMs = 1000          // how long the user must be quiet before their turn ends
    var bargeIn = true            // keep listening while speaking so the user can interrupt
    var openaiKey = ""            // not encoded; see load/save

    enum CodingKeys: String, CodingKey {
        case engine, liveModel, realtimeModel, ttsModel, voice, sttModel, language, silenceMs, bargeIn
    }

    static let liveOnlyVoices = ["bossa", "tempo", "gleam", "meridian", "vesper", "willow", "stone", "ripple", "quartz", "delta", "cinder", "beacon"]
    static let allVoices = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]

    var isPortuguese: Bool { language.lowercased().hasPrefix("pt") }

    private static let key = "settings.v1"

    static func load() -> Settings {
        var s = Settings()
        if let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode(Settings.self, from: data) { s = saved }
        s.openaiKey = Keychain.get("openai-key") ?? ""
        return s
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
        if Keychain.get("openai-key") != openaiKey { Keychain.set("openai-key", openaiKey) }
    }
}

/// A Mac paired with `claude-voice pair`. The token is in the Keychain, keyed by host.
struct PairedMac: Codable, Identifiable, Equatable {
    var host: String   // e.g. MacBook-Pro.local (Bonjour sessions advertise the same host)
    var name: String
    var id: String { host.lowercased() }
    var token: String? { Keychain.get("pair:\(id)") }

    private static let key = "pairedMacs"

    static func all() -> [PairedMac] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([PairedMac].self, from: data)) ?? []
    }

    static func save(_ macs: [PairedMac]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(macs), forKey: key)
    }

    /// Parses claudevoice://pair?token=…&host=…&name=…
    static func from(url: URL) -> (PairedMac, String)? {
        guard url.scheme == "claudevoice", url.host == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let q = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard let token = q["token"], !token.isEmpty, let host = q["host"], !host.isEmpty else { return nil }
        return (PairedMac(host: host, name: q["name"].flatMap { $0.isEmpty ? nil : $0 } ?? host), token)
    }
}
