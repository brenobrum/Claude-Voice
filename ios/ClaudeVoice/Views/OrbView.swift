import SwiftUI

/// Smoothed orb uniforms. A plain class (not observed): it's advanced once per frame by the TimelineView.
private final class OrbState {
    var level: Float = 0, low: Float = 0, high: Float = 0, speak: Float = 0, active: Float = 0, flow: Float = 0
    var last = Date()
    let t0 = Date()

    // Gentle attack, slow release: it swells with speech rather than flickering per syllable.
    private func follow(_ cur: Float, _ to: Float, _ up: Float = 0.1, _ down: Float = 0.025) -> Float {
        cur + (to - cur) * (to > cur ? up : down)
    }

    func step(_ m: Meter, now: Date) {
        level = follow(level, min(1, m.mic * 4.5))
        low = follow(low, min(1, m.mic * 3))
        high = follow(high, min(1, m.micHigh * m.mic * 12))
        speak = follow(speak, min(1, m.out * 4), 0.08, 0.025)
        active = follow(active, m.micActive ? 1 : 0, 0.06, 0.04)
        let dt = Float(min(0.05, now.timeIntervalSince(last)))
        last = now
        flow += dt * (0.12 + min(1, level * 1.2 + speak * 0.25) * 0.22)
    }
}

struct OrbView: View {
    let meter: Meter
    @State private var state = OrbState()

    var body: some View {
        TimelineView(.animation) { ctx in
            let s = advance(ctx.date)
            GeometryReader { geo in
                Rectangle()
                    .colorEffect(ShaderLibrary.orb(
                        .float2(geo.size),
                        .float(Float(ctx.date.timeIntervalSince(s.t0))),
                        .float(s.flow), .float(s.level), .float(s.low), .float(s.high),
                        .float(s.active), .float(s.speak)
                    ))
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityLabel("Microphone orb")
    }

    private func advance(_ date: Date) -> OrbState {
        state.step(meter, now: date)
        return state
    }
}
