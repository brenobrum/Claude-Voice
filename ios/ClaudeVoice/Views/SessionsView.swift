import SwiftUI
import VisionKit

/// Live Claude Code sessions on paired Macs, plus pairing.
struct SessionsView: View {
    @EnvironmentObject var vc: VoiceController
    @ObservedObject var discovery: Discovery
    @ObservedObject var channel: ChannelClient
    @Environment(\.dismiss) private var dismiss
    @State private var pairing = false

    var body: some View {
        NavigationStack {
            List {
                if let err = discovery.error {
                    Section { Text(err).font(.footnote).foregroundStyle(Theme.warn) }
                }
                if vc.pairedMacs.isEmpty {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Pair with your Mac").font(.headline)
                            Text("On your Mac, run this in a terminal, then scan the QR code it shows:")
                                .font(.footnote).foregroundStyle(Theme.muted)
                            Text("claude-voice pair").font(.callout.monospaced())
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.panel))
                            Text("Your phone and Mac must be on the same Wi-Fi. Claude Code sessions started after pairing show up here.")
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                        .padding(.vertical, 4)
                        Button { pairing = true } label: { Label("Scan pairing code", systemImage: "qrcode.viewfinder") }
                    }
                }
                ForEach(vc.pairedMacs) { mac in
                    let sessions = discovery.sessions.filter { $0.macID == mac.id }
                    Section {
                        if sessions.isEmpty {
                            Text("No running sessions. Start one on the Mac with claude-voice (or restart sessions that were running before you paired).")
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                        ForEach(sessions) { s in
                            Button { vc.connect(s); dismiss() } label: { row(s) }
                        }
                    } header: {
                        HStack {
                            Image(systemName: "laptopcomputer")
                            Text(mac.name)
                        }
                    }
                }
                let strangers = discovery.sessions.filter { s in !vc.pairedMacs.contains { $0.id == s.macID } }
                if !strangers.isEmpty {
                    Section("Not paired") {
                        ForEach(strangers) { s in row(s).opacity(0.5) }
                        Button { pairing = true } label: { Label("Pair with this Mac", systemImage: "qrcode.viewfinder") }
                    }
                }
                if channel.session != nil {
                    Section { Button("Disconnect", role: .destructive) { vc.disconnect(); dismiss() } }
                }
                if !vc.pairedMacs.isEmpty {
                    Section("Paired Macs") {
                        ForEach(vc.pairedMacs) { mac in
                            Text(mac.name).swipeActions { Button("Unpair", role: .destructive) { vc.unpair(mac) } }
                        }
                        Button { pairing = true } label: { Label("Pair another Mac", systemImage: "plus") }
                    }
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { discovery.restart() } label: { Image(systemName: "arrow.clockwise") } }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .sheet(isPresented: $pairing) { PairView() }
        }
        .preferredColorScheme(.dark)
    }

    private func row(_ s: SessionInfo) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "terminal").foregroundStyle(Theme.accent).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.project).font(.body.weight(.medium)).foregroundStyle(Theme.text)
                Text(s.cwd).font(.caption.monospaced()).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.head)
            }
            Spacer()
            if channel.session?.id == s.id {
                Text(channel.state == .connected ? "Connected" : "Connecting…")
                    .font(.caption).foregroundStyle(channel.state == .connected ? Theme.ok : Theme.muted)
            } else if let started = s.started {
                Text(started, style: .relative).font(.caption).foregroundStyle(Theme.muted)
            }
        }
    }
}

/// Scan the QR code from `claude-voice pair`, or type host + token.
struct PairView: View {
    @EnvironmentObject var vc: VoiceController
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var token = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if DataScannerViewController.isSupported {
                    Section {
                        QRScanner { code in
                            if let url = URL(string: code), vc.pair(url: url) { dismiss() }
                            else { error = "That isn't a Claude Voice pairing code." }
                        }
                        .frame(height: 300)
                        .listRowInsets(EdgeInsets())
                    } footer: { Text("Point the camera at the QR code from claude-voice pair.") }
                }
                Section {
                    TextField("Mac host (e.g. MacBook-Pro.local)", text: $host)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Token", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.body.monospaced())
                    Button("Pair") {
                        let h = host.trimmingCharacters(in: .whitespaces)
                        let t = token.trimmingCharacters(in: .whitespaces)
                        guard !h.isEmpty, !t.isEmpty else { error = "Enter both the host and the token."; return }
                        let full = h.contains(".") ? h : "\(h).local"
                        vc.pair(PairedMac(host: full, name: h.replacingOccurrences(of: ".local", with: "")), token: t)
                        dismiss()
                    }
                } header: { Text("Or enter it by hand") }
                footer: { Text("claude-voice pair prints the host and token under the QR code.") }
                if let error { Section { Text(error).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("Pair a Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                           qualityLevel: .balanced, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case let .barcode(b) in items {
                guard !done, let s = b.payloadStringValue, s.hasPrefix("claudevoice://") else { continue }
                done = true
                scanner.stopScanning()
                onCode(s)
            }
        }
    }
}
