import SwiftUI

enum Palette {
    static let paper = Color(hex: "fbf9f2")
    static let background = Color(hex: "edeae4")
    static let sidebar = Color(hex: "f5f2ec")
    static let ink = Color(hex: "3b343e")
    static let muted = Color(hex: "6f6863")
    static let line = Color(hex: "dcd6cc")
    static let plum = Color(hex: "665463")
    static let green = Color(hex: "7b866d")
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
