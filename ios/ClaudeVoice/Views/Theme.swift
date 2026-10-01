import SwiftUI

enum Theme {
    static let bg = Color(hex: 0x0d0b0a)
    static let panel = Color(hex: 0x1c1917)
    static let border = Color(hex: 0x2c2724)
    static let text = Color(hex: 0xf2ede9)
    static let muted = Color(hex: 0x8c827b)
    static let accent = Color(hex: 0xe8794a)
    static let danger = Color(hex: 0xe5484d)
    static let warn = Color(hex: 0xe2a336)
    static let ok = Color(hex: 0x3fb950)

    static let background = RadialGradient(colors: [Color(hex: 0x1a1310), bg], center: UnitPoint(x: 0.5, y: 0.45),
                                           startRadius: 0, endRadius: 520)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
}

/// Status circle: orange and pulsing while running, gray when stopped.
struct StatusDot: View {
    var running: Bool
    var size: CGFloat = 9
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(running ? Theme.accent : Color(hex: 0x6b625c))
            .frame(width: size, height: size)
            .background {
                if running {
                    Circle().stroke(Theme.accent.opacity(pulse ? 0 : 0.55), lineWidth: pulse ? 7 : 0)
                        .scaleEffect(pulse ? 1.9 : 1)
                        .animation(.easeOut(duration: 1.4).repeatForever(autoreverses: false), value: pulse)
                        .onAppear { pulse = true }
                }
            }
    }
}
