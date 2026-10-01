import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vc: VoiceController
    @ObservedObject var channel: ChannelClient
    @ObservedObject var discovery: Discovery
    enum Panel: String, Identifiable { case sessions, settings, agents, history, pair; var id: String { rawValue } }
    @State private var panel: Panel?
    @State private var typing = false
    @FocusState private var typingFocused: Bool

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                stage
                footer
            }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $panel, onDismiss: { vc.showAgents = false }) { p in
            switch p {
            case .sessions: ThreadsView(discovery: discovery, channel: channel, tab: .threads)
            case .settings: SettingsView(draft: vc.settings)
            case .agents: ThreadsView(discovery: discovery, channel: channel, tab: .agents)
            case .history: HistoryView()
            case .pair: PairView()
            }
        }
        .onChange(of: discovery.sessions) { _, all in vc.sessionsChanged(all) }
        // A new sub-agent pops the panel open (unless another one is up).
        .onChange(of: vc.showAgents) { _, show in if show && panel == nil { panel = .agents } }
        .onAppear {
            vc.start()
            if vc.pairedMacs.isEmpty { panel = .sessions }
        }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 10) {
            Button { panel = .sessions } label: {
                HStack(spacing: 8) {
                    Circle().fill(vc.connected ? Theme.ok : Theme.muted).frame(width: 7, height: 7)
                        .shadow(color: vc.connected ? Theme.ok : .clear, radius: 4)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(channel.session?.project ?? "Claude Voice").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                        Text(channel.session?.machine ?? "Pick a thread").font(.caption2).foregroundStyle(Theme.muted)
                    }
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                }
            }
            .accessibilityLabel("Threads")
            Spacer()
            Button { panel = .agents } label: {
                HStack(spacing: 6) {
                    StatusDot(running: vc.runningAgents > 0, size: 8)
                    Text(vc.runningAgents > 0 ? "\(vc.runningAgents)/\(vc.agents.count)" : "\(vc.agents.count)")
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                }
                .foregroundStyle(Theme.muted)
                .padding(.horizontal, 10).frame(height: 28)
                .background(Capsule().fill(Color.white.opacity(0.05)))
            }
            .accessibilityLabel("Sub-agents")
            Button { panel = .settings } label: {
                Image(systemName: "gearshape").font(.system(size: 18)).foregroundStyle(Theme.muted).frame(width: 36, height: 36)
            }
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 16).padding(.top, 8)
    }

    // MARK: stage

    private var stage: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            OrbView(meter: vc.meter)
                .frame(maxWidth: typing ? 240 : 380)
                .padding(.horizontal, 12)
                .contentShape(Circle())
                .onTapGesture { vc.primaryAction() }
                .animation(.easeInOut(duration: 0.25), value: typing)
            if vc.activity.visible {
                ActivityView(activity: vc.activity)
                    .padding(.horizontal, 24)
                    .padding(.top, -20)
                    .padding(.bottom, 16)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            captionView
                .frame(maxWidth: 380, minHeight: 66, alignment: .top)
                .padding(.horizontal, 24)
                .padding(.top, -12)
            if let req = vc.permission { PermissionCard(req: req, answer: vc.permissionAnswer).padding(.horizontal, 16) }
            Spacer(minLength: 0)
        }
        .animation(.easeOut(duration: 0.2), value: vc.activity.visible)
    }

    @ViewBuilder private var captionView: some View {
        if vc.needsAttach {
            Text("This is a Claude desktop-app session: type /voice phone in it so Claude can hear you. What you said is kept and delivered then.")
                .font(.footnote)
                .foregroundStyle(Theme.warn)
                .multilineTextAlignment(.center)
                .lineLimit(5)
        } else if let note = vc.note, vc.caption == nil || note.kind != .info {
            Text(note.text)
                .font(.footnote)
                .foregroundStyle(note.kind == .error ? Theme.danger : note.kind == .warn ? Theme.warn : Theme.muted)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .onTapGesture { vc.dismissNote() }
                .transition(.opacity)
        } else if let c = vc.caption {
            Text(c.text)
                .font(.system(size: 16))
                .italic(c.partial && c.role == .user)
                .foregroundStyle(c.role == .user ? Theme.muted : Theme.text)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .truncationMode(.head)
                .animation(.easeOut(duration: 0.2), value: c.text)
        } else if vc.pairedMacs.isEmpty {
            hint("Pair this phone with your Mac: run claude-voice pair there and scan the code.")
        } else if !vc.hasKey {
            hint("Add your OpenAI API key in Settings.")
        } else if !vc.connected {
            hint(discovery.sessions.isEmpty
                 ? "No Claude Code sessions found. Start one on your Mac with claude-voice."
                 : "Tap the name above to pick a Claude Code thread, or open a new one.")
        }
    }

    private func hint(_ s: String) -> some View {
        Text(s).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
    }

    // MARK: footer

    private var footer: some View {
        VStack(spacing: 10) {
            if typing {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Add context for your next message…", text: $vc.contextText, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($typingFocused)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border))
                    Button { vc.sendTyped() } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)).foregroundStyle(Theme.accent)
                    }
                    .disabled(vc.contextText.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel("Send now as a message")
                }
                .padding(.horizontal, 16)
                Text("Rides along with your next voice message — or tap ↑ to send it on its own.")
                    .font(.caption2).foregroundStyle(Theme.muted)
            }
            // Same row as the Mac app: history · mode · (mic) · keyboard · QR.
            HStack(spacing: 12) {
                CircleButton(systemImage: "bubble.left", active: false, label: "Message history") { panel = .history }
                CircleButton(systemImage: vc.settings.engine == .live ? "bubble.left.and.bubble.right" : "doc.text",
                             active: false,
                             label: vc.settings.engine == .live ? "Mode: GPT-Live (tap for GPT-Realtime)" : "Mode: GPT-Realtime (tap for GPT-Live)") {
                    vc.toggleMode()
                }
                Button { vc.toggleMic() } label: {
                    Image(systemName: vc.listening ? "mic.fill" : "mic.slash")
                        .font(.system(size: 22))
                        .foregroundStyle(vc.listening ? .white : Theme.muted)
                        .frame(width: 64, height: 64)
                        .background(Circle().fill(vc.listening ? Theme.accent : Theme.panel))
                        .overlay(Circle().stroke(vc.listening ? Theme.accent : Theme.border))
                }
                .accessibilityLabel(vc.listening ? "Turn microphone off" : "Turn microphone on")
                .padding(.horizontal, 6)
                CircleButton(systemImage: "keyboard", active: typing || !vc.contextText.isEmpty, label: "Add text context") {
                    typing.toggle()
                    // Focus once the field exists (it's inserted by this same toggle).
                    DispatchQueue.main.async { typingFocused = typing }
                }
                .focusable(false)
                CircleButton(systemImage: "qrcode.viewfinder", active: false, label: "Scan a pairing QR code") { panel = .pair }
            }
            Text(vc.status).font(.footnote).foregroundStyle(Theme.muted)
            if !channel.cwd.isEmpty {
                Text(channel.cwd.replacingOccurrences(of: #"^/(Users|home)/[^/]+"#, with: "~", options: .regularExpression))
                    .font(.caption2.monospaced()).foregroundStyle(Theme.muted.opacity(0.7)).lineLimit(1).truncationMode(.head)
                    .padding(.horizontal, 24)
            }
        }
        .padding(.bottom, 12)
    }
}

/// Small round footer button, like the Mac app's `.ctx` buttons.
struct CircleButton: View {
    let systemImage: String
    let active: Bool
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16))
                .foregroundStyle(active ? Theme.accent : Theme.muted)
                .frame(width: 42, height: 42)
                .background(Circle().fill(Color.white.opacity(0.05)))
                .overlay(Circle().stroke(active ? Theme.accent : Theme.border))
        }
        .accessibilityLabel(label)
    }
}

struct PermissionCard: View {
    @EnvironmentObject var vc: VoiceController
    let req: PermissionRequest
    let answer: String?

    private var preview: some View {
        Text(req.inputPreview).font(.caption.monospaced()).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Claude wants to use \(req.toolName): \(req.description)")
                .font(.footnote.weight(.medium)).foregroundStyle(Theme.text)
            if !req.inputPreview.isEmpty {
                ViewThatFits(in: .vertical) {
                    preview
                    ScrollView { preview }
                }
                .frame(maxHeight: 110)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.3)))
            }
            if let answer {
                Text(answer).font(.footnote.weight(.semibold)).foregroundStyle(answer.hasPrefix("✓") ? Theme.ok : Theme.danger)
            } else {
                HStack {
                    Button("Allow") { vc.answerPermission(allow: true) }
                        .buttonStyle(.borderedProminent).tint(Theme.accent)
                    Button("Deny") { vc.answerPermission(allow: false) }
                        .buttonStyle(.bordered).tint(Theme.muted)
                    Spacer()
                    Text("or say yes / no").font(.caption2).foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.accent.opacity(0.5)))
    }
}

/// What the Claude thread is doing, under the orb: "Thinking…" or the running tool, with elapsed time,
/// plus sub-agents working in the background.
struct ActivityView: View {
    let activity: ClaudeActivity

    var body: some View {
        VStack(spacing: 6) {
            if activity.busy {
                HStack(spacing: 7) {
                    TypingDots()
                    if activity.state == "tool", !activity.detail.isEmpty {
                        let parts = activity.detail.components(separatedBy: "  ")
                        Text(parts[0]).font(.caption.weight(.semibold)).foregroundStyle(Theme.text).layoutPriority(1)
                        if parts.count > 1 {
                            Text(parts.dropFirst().joined(separator: "  "))
                                .font(.caption2.monospaced()).foregroundStyle(Theme.muted)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    } else {
                        Text("Thinking…").font(.caption.weight(.medium)).foregroundStyle(Theme.text)
                    }
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(Self.elapsed(ctx.date.timeIntervalSince(activity.since)))
                            .font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
                    }
                    .layoutPriority(1)
                }
                .padding(.horizontal, 11).frame(height: 26)
                .background(Capsule().fill(Theme.accent.opacity(0.1)))
                .overlay(Capsule().stroke(Theme.accent.opacity(0.35)))
            }
            if let first = activity.background.first {
                HStack(spacing: 6) {
                    StatusDot(running: true, size: 7)
                    Text(activity.background.count == 1 ? "In background: \(first.label)" : "\(activity.background.count) in background: \(first.label)")
                        .font(.caption2).foregroundStyle(Theme.muted).layoutPriority(1)
                    if !first.activity.isEmpty {
                        Text("— \(first.activity)").font(.caption2.monospaced()).foregroundStyle(Theme.muted.opacity(0.8))
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
            }
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    static func elapsed(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        return s < 60 ? "\(s)s" : "\(s / 60)m \(String(format: "%02d", s % 60))s"
    }
}

/// Three dots bouncing in turn, like a typing indicator.
struct TypingDots: View {
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<3) { i in
                    let phase = (t / 1.2 - Double(i) * 0.125).truncatingRemainder(dividingBy: 1)
                    let up = phase < 0.4 ? sin(phase / 0.4 * .pi) : 0
                    Circle().fill(Theme.accent).frame(width: 4, height: 4)
                        .opacity(0.25 + 0.75 * up).offset(y: -2 * up)
                }
            }
        }
        .accessibilityHidden(true)
    }
}
