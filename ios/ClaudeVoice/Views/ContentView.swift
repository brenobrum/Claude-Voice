import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vc: VoiceController
    @ObservedObject var channel: ChannelClient
    @ObservedObject var discovery: Discovery
    @State private var showSessions = false
    @State private var showSettings = false
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
        .sheet(isPresented: $showSessions) { SessionsView(discovery: discovery, channel: channel) }
        .sheet(isPresented: $showSettings) { SettingsView(draft: vc.settings) }
        .sheet(isPresented: $vc.showAgents) { AgentsView() }
        .onChange(of: discovery.sessions) { _, all in vc.sessionsChanged(all) }
        .onAppear {
            vc.start()
            if vc.pairedMacs.isEmpty || !vc.hasKey { showSessions = vc.pairedMacs.isEmpty; showSettings = !vc.pairedMacs.isEmpty && !vc.hasKey }
        }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 10) {
            Button { showSessions = true } label: {
                HStack(spacing: 8) {
                    Circle().fill(vc.connected ? Theme.ok : Theme.muted).frame(width: 7, height: 7)
                        .shadow(color: vc.connected ? Theme.ok : .clear, radius: 4)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(channel.session?.project ?? "Claude Voice").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                        Text(channel.session?.machine ?? "Pick a session").font(.caption2).foregroundStyle(Theme.muted)
                    }
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                }
            }
            .accessibilityLabel("Sessions")
            Spacer()
            Button { vc.showAgents = true } label: {
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
            Button { showSettings = true } label: {
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
            captionView
                .frame(maxWidth: 380, minHeight: 66, alignment: .top)
                .padding(.horizontal, 24)
                .padding(.top, -12)
            if let req = vc.permission { PermissionCard(req: req, answer: vc.permissionAnswer).padding(.horizontal, 16) }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private var captionView: some View {
        if let note = vc.note, vc.caption == nil || note.kind != .info {
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
                 : "Tap the session name above to pick a Claude Code thread.")
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
            HStack(spacing: 28) {
                Color.clear.frame(width: 44, height: 44)
                Button { vc.toggleMic() } label: {
                    Image(systemName: vc.listening ? "mic.fill" : "mic.slash")
                        .font(.system(size: 22))
                        .foregroundStyle(vc.listening ? .white : Theme.muted)
                        .frame(width: 64, height: 64)
                        .background(Circle().fill(vc.listening ? Theme.accent : Theme.panel))
                        .overlay(Circle().stroke(vc.listening ? Theme.accent : Theme.border))
                }
                .accessibilityLabel(vc.listening ? "Turn microphone off" : "Turn microphone on")
                Button {
                    typing.toggle()
                    typingFocused = typing
                } label: {
                    Image(systemName: "keyboard")
                        .font(.system(size: 17))
                        .foregroundStyle(typing || !vc.contextText.isEmpty ? Theme.accent : Theme.muted)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(typing ? Color.white.opacity(0.06) : .clear))
                }
                .accessibilityLabel("Add text context")
            }
            Text(vc.status).font(.footnote).foregroundStyle(Theme.muted)
            if !channel.cwd.isEmpty {
                Text(channel.cwd.replacingOccurrences(of: #"^/(Users|home)/[^/]+"#, with: "~", options: .regularExpression))
                    .font(.caption2.monospaced()).foregroundStyle(Theme.muted.opacity(0.7)).lineLimit(1).truncationMode(.head)
            }
        }
        .padding(.bottom, 12)
    }
}

struct PermissionCard: View {
    @EnvironmentObject var vc: VoiceController
    let req: PermissionRequest
    let answer: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Claude wants to use \(req.toolName): \(req.description)")
                .font(.footnote.weight(.medium)).foregroundStyle(Theme.text)
            if !req.inputPreview.isEmpty {
                ScrollView {
                    Text(req.inputPreview).font(.caption.monospaced()).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
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
