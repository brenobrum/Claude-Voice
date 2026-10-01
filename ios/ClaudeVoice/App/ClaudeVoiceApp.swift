import SwiftUI

@main
struct ClaudeVoiceApp: App {
    @StateObject private var vc = VoiceController()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView(channel: vc.channel, discovery: vc.discovery)
                .environmentObject(vc)
                .tint(Theme.accent)
                // claudevoice://pair?… from the Camera app.
                .onOpenURL { url in vc.pair(url: url) }
                .onChange(of: phase) { _, p in if p == .active { vc.appBecameActive() } }
        }
    }
}
