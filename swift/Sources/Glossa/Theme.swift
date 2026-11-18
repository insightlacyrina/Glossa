import SwiftUI
import AppKit

enum Palette {
    static let paper = adaptive("fbf9f2", "252320")
    static let background = adaptive("edeae4", "141413")
    static let sidebar = adaptive("f5f2ec", "1c1b19")
    static let ink = adaptive("3b343e", "f5f0e8")
    static let muted = adaptive("6f6863", "a9a39b")
    static let line = adaptive("dcd6cc", "35322d")
    static let plum = adaptive("665463", "c9adbf")
    static let green = adaptive("7b866d", "a8b39e")

    private static func adaptive(_ light: String, _ dark: String) -> Color {
        let lightColor = NSColor(Color(hex: light)), darkColor = NSColor(Color(hex: dark))
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? darkColor : lightColor
        })
    }

    static func paperInk(_ hex: String, dark: Bool) -> Color {
        let color = Color(hex: hex)
        guard dark, let original = NSColor(color).usingColorSpace(.sRGB),
              let cream = NSColor(Color(hex: "f5f0e8")).usingColorSpace(.sRGB) else { return color }
        func linear(_ channel: CGFloat) -> CGFloat {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        for step in 0...10 {
            let candidate = original.blended(withFraction: CGFloat(step) / 10, of: cream) ?? cream
            let luminance = 0.2126 * linear(candidate.redComponent)
                + 0.7152 * linear(candidate.greenComponent) + 0.0722 * linear(candidate.blueComponent)
            if (luminance + 0.05) / 0.067 >= 4.5 { return Color(nsColor: candidate) }
        }
        return Color(nsColor: cream)
    }
}
extension Color {
    init(hex: String) {
        var clean = hex.replacingOccurrences(of: "#", with: "")
        if clean.count == 3 { clean = clean.map { "\($0)\($0)" }.joined() }
        guard let n = UInt64(clean, radix: 16), [6, 8].contains(clean.count) else { self = Palette.ink; return }
        let hasAlpha = clean.count == 8
        self.init(.sRGB, red: Double((n >> (hasAlpha ? 24 : 16)) & 255) / 255,
                  green: Double((n >> (hasAlpha ? 16 : 8)) & 255) / 255,
                  blue: Double((n >> (hasAlpha ? 8 : 0)) & 255) / 255,
                  opacity: hasAlpha ? Double(n & 255) / 255 : 1)
    }
}
struct PrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.medium))
            .padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(Palette.paper).background(Palette.plum.opacity(configuration.isPressed ? 0.8 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .opacity(isEnabled ? 1 : 0.45)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: configuration.isPressed)
    }
}
struct QuietButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 8)
            .background(configuration.isPressed ? Palette.line : Palette.paper)
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Palette.line))
            .opacity(isEnabled ? 1 : 0.45)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: configuration.isPressed)
    }
}
struct Eyebrow: View {
    let text: String
    var body: some View { Text(text).font(.system(.caption, design: .monospaced).weight(.medium)).tracking(1.4).foregroundStyle(Palette.muted) }
}
struct EmptyState: View {
    let symbol: String
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: symbol).font(.system(size: 36, weight: .light)).foregroundStyle(Palette.plum).accessibilityHidden(true)
            Text(title).font(.custom("Songti SC", size: 25))
            Text(message).font(.body).foregroundStyle(Palette.muted).lineSpacing(5).multilineTextAlignment(.center).frame(maxWidth: 360)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(28)
    }
}
