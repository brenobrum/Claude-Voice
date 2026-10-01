import AVFoundation
import Accelerate

/// Raw levels for the orb, written from audio threads and read by the renderer (benign races on floats).
final class Meter {
    var mic: Float = 0      // rms of the mic
    var micHigh: Float = 0  // rough "brightness" of the mic (zero-crossing rate)
    var out: Float = 0      // rms of Claude's voice
    var micActive = false
}

/// Mic capture (24 kHz PCM16, ~100 ms frames) and playback of 24 kHz PCM16 streams, on one AVAudioEngine
/// with voice processing (echo cancellation) while the mic is open, so you can talk over Claude.
/// GPT-Live doesn't use this: WebRTC owns the audio session then.
final class AudioIO {
    static let rate = 24000.0
    static let frameSamples = 2400   // 100 ms

    let meter = Meter()
    /// Called on the audio thread with a PCM16 frame and its peak (0…1).
    var onMicFrame: ((Data, Float) -> Void)?
    /// Called on the main thread when Claude's voice starts / stops being audible.
    var onSpeakingChange: ((Bool) -> Void)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
    private let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
    private var converter: AVAudioConverter?
    private var pending = [Int16]()
    private var pendingPeak: Float = 0

    private(set) var micOn = false
    private var running = false
    private var queueEnd: TimeInterval = 0   // wall-clock time the scheduled audio finishes
    private(set) var speaking = false
    private var speakTimer: Timer?
    private var muteUntil: TimeInterval = 0

    init() {
        engine.attach(player)
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended, self.running else { return }
            self.restart()
        }
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self, self.running else { return }
            self.restart()
        }
    }

    // MARK: lifecycle

    /// Opens or closes the mic. Playback keeps working either way.
    func setMic(_ on: Bool) throws {
        guard on != micOn || !running else { return }
        micOn = on
        try rebuild()
    }

    /// Releases the audio hardware entirely (GPT-Live takes over the session).
    func shutdown() {
        stopPlayback()
        engine.inputNode.removeTap(onBus: 0)
        engine.mainMixerNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        micOn = false
        meter.micActive = false
        meter.mic = 0
    }

    private func restart() {
        try? rebuild()
    }

    private func rebuild() throws {
        engine.inputNode.removeTap(onBus: 0)
        engine.mainMixerNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: micOn ? .voiceChat : .spokenAudio,
                                options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)

        // Voice processing = hardware echo cancellation, so Claude doesn't hear itself.
        if engine.inputNode.isVoiceProcessingEnabled != micOn {
            try engine.inputNode.setVoiceProcessingEnabled(micOn)
        }
        if micOn {
            engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration =
                .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        if micOn {
            let inFormat = engine.inputNode.outputFormat(forBus: 0)
            converter = AVAudioConverter(from: inFormat, to: pcmFormat)
            pending.removeAll(keepingCapacity: true)
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buf, _ in
                self?.capture(buf)
            }
        }
        let mixFormat = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: mixFormat) { [weak self] buf, _ in
            guard let self, let ch = buf.floatChannelData?[0] else { return }
            var rms: Float = 0
            vDSP_rmsqv(ch, 1, &rms, vDSP_Length(buf.frameLength))
            self.meter.out = rms
        }
        engine.prepare()
        try engine.start()
        player.play()
        running = true
        meter.micActive = micOn
        if !micOn { meter.mic = 0 }
    }

    // MARK: mic

    private func capture(_ buf: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = Self.rate / buf.format.sampleRate
        let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio + 32)
        guard let out = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, let s = out.int16ChannelData?[0] else { return }
        let n = Int(out.frameLength)
        var crossings = 0
        var sumSq: Float = 0
        for i in 0..<n {
            let v = s[i]
            pending.append(v)
            let f = Float(v) / 32768
            sumSq += f * f
            let a = abs(f)
            if a > pendingPeak { pendingPeak = a }
            if i > 0 && (s[i - 1] < 0) != (v < 0) { crossings += 1 }
        }
        if n > 0 {
            meter.mic = (sumSq / Float(n)).squareRoot()
            meter.micHigh = min(1, Float(crossings) / Float(n) * 6)
        }
        while pending.count >= Self.frameSamples {
            let frame = pending.prefix(Self.frameSamples)
            let data = frame.withContiguousStorageIfAvailable { Data(buffer: $0) } ?? Data(buffer: UnsafeBufferPointer(start: Array(frame), count: frame.count))
            pending.removeFirst(Self.frameSamples)
            let peak = pendingPeak
            pendingPeak = 0
            onMicFrame?(data, peak)
        }
    }

    // MARK: playback

    /// Queue a chunk of 24 kHz little-endian PCM16 for playback.
    func play(_ pcm: Data) {
        let now = Date().timeIntervalSince1970
        if now < muteUntil { return }            // just interrupted by the user
        let count = pcm.count / 2
        guard count > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(count)),
              let dst = buf.floatChannelData?[0] else { return }
        buf.frameLength = AVAudioFrameCount(count)
        pcm.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            var scale = Float(1) / 32768
            vDSP_vflt16(src.baseAddress!, 1, dst, 1, vDSP_Length(count))
            vDSP_vsmul(dst, 1, &scale, dst, 1, vDSP_Length(count))
        }
        if !running { try? rebuild() }
        player.scheduleBuffer(buf)
        if !player.isPlaying { player.play() }
        queueEnd = max(now, queueEnd) + Double(count) / Self.rate
        DispatchQueue.main.async { self.watchSpeaking() }
    }

    /// Drop everything queued (barge-in / stop). Optionally ignore audio for a moment, since the
    /// server keeps streaming briefly before it registers the interruption.
    func stopPlayback(muteFor seconds: TimeInterval = 0) {
        player.stop()
        if running { player.play() }
        queueEnd = 0
        muteUntil = Date().timeIntervalSince1970 + seconds
        setSpeaking(false)
    }

    private func watchSpeaking() {
        setSpeaking(true)
        guard speakTimer == nil else { return }
        speakTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self else { return }
            // Small tail so the mic doesn't pick up the last syllable echoing in the room.
            if Date().timeIntervalSince1970 > self.queueEnd + 0.4 { self.setSpeaking(false) }
        }
    }

    private func setSpeaking(_ on: Bool) {
        if !on { speakTimer?.invalidate(); speakTimer = nil }
        guard on != speaking else { return }
        speaking = on
        onSpeakingChange?(on)
    }
}
