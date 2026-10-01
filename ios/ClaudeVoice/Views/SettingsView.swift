import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var vc: VoiceController
    @Environment(\.dismiss) private var dismiss
    @State var draft: Settings

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk-…", text: $draft.openaiKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("OpenAI API key") }
                footer: { Text("Stored in this iPhone's Keychain. Speech and voice go straight from the phone to OpenAI.") }

                Section("Voice") {
                    Picker("Engine", selection: $draft.engine) {
                        ForEach(VoiceEngine.allCases) { Text($0.label).tag($0) }
                    }
                    Picker("Voice", selection: $draft.voice) {
                        ForEach(Settings.allVoices, id: \.self) { Text($0).tag($0) }
                        if draft.engine == .live || Settings.liveOnlyVoices.contains(draft.voice) {
                            Section("GPT-Live only") {
                                ForEach(Settings.liveOnlyVoices, id: \.self) { v in
                                    Text(v == "bossa" ? "bossa (PT-BR, feminine)" : v == "tempo" ? "tempo (PT-BR, masculine)" : v).tag(v)
                                }
                            }
                        }
                    }
                    Toggle("Interrupt by talking over Claude", isOn: $draft.bargeIn)
                        .disabled(draft.engine == .live)
                    Button("Test voice") {
                        vc.save(draft)
                        vc.testVoice()
                    }
                }

                Section("Listening") {
                    LabeledContent("Language") {
                        TextField("pt (default), en…", text: $draft.language)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    Stepper(value: $draft.silenceMs, in: 200...3000, step: 100) {
                        LabeledContent("End-of-turn silence", value: "\(draft.silenceMs) ms")
                    }
                }

                Section("Models") {
                    field("GPT-Live", $draft.liveModel)
                    field("Realtime voice", $draft.realtimeModel)
                    field("TTS", $draft.ttsModel)
                    field("Transcription", $draft.sttModel)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        draft.openaiKey = draft.openaiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                        vc.save(draft)
                        dismiss()
                    }.bold()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func field(_ label: String, _ value: Binding<String>) -> some View {
        LabeledContent(label) {
            TextField(label, text: value)
                .multilineTextAlignment(.trailing)
                .font(.callout.monospaced())
                .textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }
}
