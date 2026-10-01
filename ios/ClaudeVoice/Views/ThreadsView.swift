import SwiftUI

/// The orchestrator: Threads (interactive Claude Code sessions on paired Macs: switch, open, end) and
/// Sub-agents (headless runs in the connected thread: watch, start, follow up, stop), as two tabs.
struct ThreadsView: View {
    enum Tab: Hashable { case threads, agents }

    @EnvironmentObject var vc: VoiceController
    @ObservedObject var discovery: Discovery
    @ObservedObject var channel: ChannelClient
    @State var tab: Tab
    @Environment(\.dismiss) private var dismiss
    @State private var newThreadMac: PairedMac?
    @State private var newAgent = false

    private var threadCount: Int { vc.sessionsForPairedMacs(discovery.sessions).count }

    var body: some View {
        NavigationStack {
            Group {
                switch tab {
                case .threads: ThreadsTab(discovery: discovery, channel: channel) { newThreadMac = $0 }
                case .agents: AgentsTab()
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                Picker("View", selection: $tab) {
                    Text(threadCount > 0 ? "Threads · \(threadCount)" : "Threads").tag(Tab.threads)
                    Text(vc.runningAgents > 0 ? "Sub-agents · \(vc.runningAgents)/\(vc.agents.count)"
                         : vc.agents.isEmpty ? "Sub-agents" : "Sub-agents · \(vc.agents.count)").tag(Tab.agents)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(.bar)
            }
            .navigationTitle(tab == .threads ? "Threads" : (channel.session.map { "Sub-agents · \($0.project)" } ?? "Sub-agents"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if tab == .threads {
                    ToolbarItem(placement: .topBarLeading) { Button { discovery.restart() } label: { Image(systemName: "arrow.clockwise") } }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { add() } label: { Image(systemName: "plus") }
                        .disabled(tab == .threads ? vc.pairedMacs.isEmpty : !vc.connected)
                        .accessibilityLabel(tab == .threads ? "New thread" : "New sub-agent")
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .sheet(item: $newThreadMac) { mac in NewThreadView(discovery: discovery, macID: mac.id) }
            .sheet(isPresented: $newAgent) { NewAgentView() }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
    }

    private func add() {
        if tab == .agents { newAgent = true; return }
        let macID = channel.session?.macID
        newThreadMac = vc.pairedMacs.first { $0.id == macID } ?? vc.pairedMacs.first
    }
}
