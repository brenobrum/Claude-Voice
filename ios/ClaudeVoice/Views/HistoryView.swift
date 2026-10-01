import SwiftUI

/// The thread's messages, like the Mac app's history panel: what you sent (with a "processing"
/// shimmer until the thread goes idle), Claude's spoken replies, and permission prompts.
struct HistoryView: View {
    @EnvironmentObject var vc: VoiceController
    @Environment(\.dismiss) private var dismiss
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if vc.history.isEmpty {
                            Text("No messages in this thread yet.")
                                .font(.footnote).foregroundStyle(Theme.muted).padding(.top, 60)
                        }
                        ForEach(Array(vc.history.enumerated()), id: \.element.id) { i, e in
                            if i == 0 || !Calendar.current.isDate(vc.history[i - 1].at, inSameDayAs: e.at) {
                                Text(e.at.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))
                                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted).padding(.top, 6)
                            }
                            Bubble(entry: e)
                        }
                        if vc.activity.visible {
                            ActivityView(activity: vc.activity).padding(.top, 4)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(16)
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: vc.history.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .background(Theme.bg)
            .navigationTitle(vc.history.isEmpty ? "Messages" : "Messages · \(vc.history.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Clear") { confirmClear = true }.disabled(vc.history.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Clear the messages of this thread?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear", role: .destructive) { vc.clearHistory() }
            }
        }
        .tint(Theme.accent)
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
    }
}

private struct Bubble: View {
    let entry: HistoryEntry
    @State private var shimmer = false

    private var sent: Bool { entry.dir == .sent }

    var body: some View {
        HStack {
            if sent { Spacer(minLength: 40) }
            VStack(alignment: sent ? .trailing : .leading, spacing: 4) {
                Text(entry.text)
                    .font(entry.kind == .permission ? .footnote.italic() : .callout)
                    .foregroundStyle(entry.kind == .permission ? Theme.muted : Theme.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 14)
                        .fill(sent ? Theme.accent.opacity(entry.kind == .permission ? 0.12 : 0.22) : Theme.panel))
                    .overlay(RoundedRectangle(cornerRadius: 14)
                        .stroke(entry.pending ? Theme.accent.opacity(shimmer ? 0.9 : 0.2) : Theme.border.opacity(sent ? 0 : 1)))
                    .animation(entry.pending ? .easeInOut(duration: 0.9).repeatForever() : .default, value: shimmer)
                    .onAppear { shimmer = entry.pending }
                    .onChange(of: entry.pending) { _, p in shimmer = p }
                HStack(spacing: 4) {
                    if entry.pending { ProgressView().controlSize(.mini).tint(Theme.accent) }
                    Text("\(sent ? "You" : "Claude") · \(entry.at.formatted(date: .omitted, time: .shortened))")
                }
                .font(.caption2).foregroundStyle(Theme.muted)
            }
            if !sent { Spacer(minLength: 40) }
        }
    }
}
