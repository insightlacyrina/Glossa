import AppKit
import Foundation

// A native vector rendition of public/icon.svg, rendered at each iconset size.
guard CommandLine.arguments.count == 2 else {
    fputs("Usage: swift create-macos-icon.swift /output/AppIcon.iconset\n", stderr)
    exit(1)
}
let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
var iconElements = Data()
func bigEndian(_ value: UInt32) -> Data {
    var bytes = value.bigEndian
    return withUnsafeBytes(of: &bytes) { Data($0) }
}

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: 1)
}

for (name, pixels, elementType) in [
    ("icon_16x16", 16, "icp4"), ("icon_16x16@2x", 32, "ic11"),
    ("icon_32x32", 32, "icp5"), ("icon_32x32@2x", 64, "ic12"),
    ("icon_128x128", 128, "ic07"), ("icon_128x128@2x", 256, "ic13"),
    ("icon_256x256", 256, "ic08"), ("icon_256x256@2x", 512, "ic14"),
    ("icon_512x512", 512, "ic09"), ("icon_512x512@2x", 1024, "ic10")
] {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                              isPlanar: false, colorSpaceName: .deviceRGB,
                              bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let scale = CGFloat(pixels) / 192
    let transform = NSAffineTransform()
    transform.translateX(by: 0, yBy: CGFloat(pixels))
    transform.scaleX(by: scale, yBy: -scale)
    transform.concat()

    color(0x373139).setFill()
    NSBezierPath(roundedRect: NSRect(x: 4, y: 4, width: 184, height: 184), xRadius: 40, yRadius: 40).fill()

    let paper = NSBezierPath()
    paper.move(to: NSPoint(x: 53, y: 43))
    paper.line(to: NSPoint(x: 121, y: 43))
    paper.line(to: NSPoint(x: 143, y: 66))
    paper.line(to: NSPoint(x: 143, y: 149))
    paper.line(to: NSPoint(x: 53, y: 149))
    paper.close()
    color(0xF8F5EC).setFill()
    paper.fill()

    color(0x8E7767).setStroke()
    let fold = NSBezierPath()
    fold.move(to: NSPoint(x: 120, y: 43))
    fold.line(to: NSPoint(x: 120, y: 67))
    fold.line(to: NSPoint(x: 143, y: 67))
    fold.lineWidth = 5
    fold.stroke()
    for (y, end) in [(92, 125), (109, 115), (126, 101)] {
        let line = NSBezierPath()
        line.move(to: NSPoint(x: 71, y: y))
        line.line(to: NSPoint(x: end, y: y))
        line.lineWidth = 5
        line.lineCapStyle = .round
        line.stroke()
    }
    color(0x9CA489).setFill()
    NSBezierPath(ovalIn: NSRect(x: 127, y: 130, width: 34, height: 34)).fill()
    NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(to: destination.appendingPathComponent(name + ".png"))
    iconElements.append(contentsOf: elementType.utf8)
    iconElements.append(bigEndian(UInt32(data.count + 8)))
    iconElements.append(data)
}

// ICNS accepts PNG elements directly. This avoids depending on iconutil's
// image-conversion service, which is unavailable in some managed build hosts.
var iconFile = Data("icns".utf8)
iconFile.append(bigEndian(UInt32(iconElements.count + 8)))
iconFile.append(iconElements)
try iconFile.write(to: destination.deletingPathExtension().appendingPathExtension("icns"))
