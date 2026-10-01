import SwiftUI

/// Sub-agents started by the main thread (spawn_agent), streamed live from the channel.
struct AgentsView: View {
    @EnvironmentObject var vc: VoiceController
    @Environment(\.dismiss) private var dismiss
    @State private var expanded: Set<String> = []

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 10) {
                    if vc.agents.isEmpty {
                        Text("No sub-agents yet. Ask Claude to “start an agent” or “run this in parallel”.")
                            .font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                            .padding(.top, 60).padding(.horizontal, 30)
                    }
                    ForEach(vc.agents) { a in
                        AgentCard(agent: a, open: expanded.contains(a.id) || (a.running && !expanded.contains("-\(a.id)"))) {
                            if expanded.contains(a.id) || (a.running && !expanded.contains("-\(a.id)")) {
                                expanded.remove(a.id); expanded.insert("-\(a.id)")
                            } else {
                                expanded.insert(a.id); expanded.remove("-\(a.id)")
                            }
                        }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg)
            .navigationTitle(vc.agents.isEmpty ? "Sub-agents" : "\(vc.runningAgents) running · \(vc.agents.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
    }
}

private struct AgentCard: View {
    @EnvironmentObject var vc: VoiceController
    let agent: Agent
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StatusDot(running: agent.running)
                Text(agent.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Spacer()
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    Text(elapsed(now: ctx.date)).font(.caption.monospaced()).foregroundStyle(Theme.muted)
                }
                if agent.running {
                    Button("Stop") { vc.stopAgent(agent.id) }
                        .font(.caption).buttonStyle(.bordered).tint(Theme.danger).controlSize(.mini)
                }
            }
            Text(agent.running ? (agent.activity.isEmpty ? "Working…" : agent.activity) : (agent.activity.isEmpty ? agent.status : agent.activity))
                .font(.caption.monospaced()).foregroundStyle(Theme.muted).lineLimit(2)
            if open && !agent.log.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(agent.log) { line in
                                Text(line.text)
                                    .font(line.kind == "tool" ? .caption2.monospaced() : .caption)
                                    .foregroundStyle(color(line.kind))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id(line.id)
                            }
                        }
                    }
                    .frame(maxHeight: 260)
                    .onAppear { proxy.scrollTo(agent.log.last?.id, anchor: .bottom) }
                    .onChange(of: agent.log.count) { _, _ in withAnimation { proxy.scrollTo(agent.log.last?.id, anchor: .bottom) } }
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(agent.running ? Theme.accent.opacity(0.4) : Theme.border))
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
    }

    private func color(_ kind: String) -> Color {
        switch kind {
        case "tool": Theme.muted
        case "error": Theme.danger
        case "prompt": Theme.accent
        default: Theme.text
        }
    }

    private func elapsed(now: Date) -> String {
        let s = max(0, Int((agent.endedAt ?? now).timeIntervalSince(agent.startedAt)))
        return s < 60 ? "\(s)s" : "\(s / 60)m\(String(format: "%02d", s % 60))"
    }
}
