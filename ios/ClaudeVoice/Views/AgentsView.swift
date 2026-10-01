import SwiftUI

/// Sub-agents tab: headless Claude Code runs in the connected thread (from spawn_agent or started here), streamed live.
struct AgentsTab: View {
    @EnvironmentObject var vc: VoiceController
    @State private var toggled: Set<String> = []   // flipped from the default (open while running)

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vc.agents.isEmpty {
                    Text(vc.connected
                         ? "No sub-agents yet. Tap + to start one, or ask Claude to “start an agent” or “run this in parallel”."
                         : "Connect to a thread to see its sub-agents.")
                        .font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                        .padding(.top, 60).padding(.horizontal, 30)
                }
                ForEach(vc.agents) { a in
                    AgentCard(agent: a, open: a.running != toggled.contains(a.id)) {
                        if toggled.contains(a.id) { toggled.remove(a.id) } else { toggled.insert(a.id) }
                    }
                }
            }
            .padding(16)
        }
        .background(Theme.bg)
    }
}

/// Start a sub-agent from the app in the connected thread; Claude is told about it and gets its result.
struct NewAgentView: View {
    @EnvironmentObject var vc: VoiceController
    @Environment(\.dismiss) private var dismiss
    @State private var task = ""
    @State private var name = ""
    @State private var mode = "auto"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Complete instructions — it doesn't see the conversation", text: $task, axis: .vertical).lineLimit(4...10)
                } header: { Text("Task") }
                Section {
                    TextField("Short label (optional)", text: $name)
                    Picker("Permissions", selection: $mode) {
                        Text("Auto").tag("auto")
                        Text("Accept edits").tag("acceptEdits")
                        Text("Plan (read-only)").tag("plan")
                    }
                } footer: {
                    Text(vc.connected
                         ? "Runs in the background in \(vc.channel.session?.project ?? "this project"). The thread's Claude hears about it and gets its result."
                         : "Connect to a thread first.")
                }
            }
            .navigationTitle("New sub-agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Start") { if vc.spawnAgent(task: task, name: name, mode: mode) { dismiss() } }
                        .disabled(!vc.connected || task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
    }
}

private struct AgentCard: View {
    @EnvironmentObject var vc: VoiceController
    let agent: Agent
    let open: Bool
    let toggle: () -> Void
    @State private var asking = false
    @State private var followUp = ""

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
                } else {
                    Button("Follow up") { followUp = "" ; asking = true }
                        .font(.caption).buttonStyle(.bordered).tint(Theme.accent).controlSize(.mini)
                }
            }
            Text(agent.running ? (agent.activity.isEmpty ? "Working…" : agent.activity) : (agent.activity.isEmpty ? agent.status : agent.activity))
                .font(.caption.monospaced()).foregroundStyle(Theme.muted).lineLimit(2)
            if open && !agent.log.isEmpty {
                // The panel already scrolls; show the latest lines (a nested ScrollView would collapse).
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(agent.log.suffix(60)) { line in
                        Text(line.text)
                            .font(line.kind == "tool" ? .caption2.monospaced() : .caption)
                            .foregroundStyle(color(line.kind))
                            .lineLimit(line.kind == "tool" ? 2 : 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(agent.running ? Theme.accent.opacity(0.4) : Theme.border))
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
        .alert("Follow up with \(agent.name)", isPresented: $asking) {
            TextField("Instruction", text: $followUp, axis: .vertical)
            Button("Send") { _ = vc.messageAgent(agent.id, followUp) }
            Button("Cancel", role: .cancel) {}
        } message: { Text("It continues with its full context.") }
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
