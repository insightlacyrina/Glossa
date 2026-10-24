import SwiftUI
import AppKit
import GlossaCore

struct PaperView: View {
    let page: CorePage
    var highlighted: Set<String> = []
    var onObject: ((CorePaperObject) -> Void)?
    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width / page.width, geometry.size.height / page.height)
            let offset = CGPoint(x: (geometry.size.width - page.width * scale) / 2,
                                 y: (geometry.size.height - page.height * scale) / 2)
            Canvas { context, _ in
                context.translateBy(x: offset.x, y: offset.y)
                context.scaleBy(x: scale, y: scale)
                context.fill(Path(CGRect(x: 0, y: 0, width: page.width, height: page.height)), with: .color(Palette.paper))
                drawTemplate(&context)
                for object in page.objects {
                    draw(object, in: &context)
                    if highlighted.contains(object.id) || !(Set(object.replacesObjectIds ?? []).intersection(highlighted)).isEmpty {
                        let b = object.bounds
                        let rect = CGRect(x: b.x - 5, y: b.y - 5, width: b.width + 10, height: b.height + 10)
                        context.fill(Path(roundedRect: rect, cornerRadius: 4), with: .color(Palette.plum.opacity(0.08)))
                        context.stroke(Path(roundedRect: rect, cornerRadius: 4), with: .color(Palette.plum.opacity(0.7)), lineWidth: 1.5)
                    }
                }
            }
            .onTapGesture { location in
                let point = CGPoint(x: (location.x - offset.x) / scale, y: (location.y - offset.y) / scale)
                if let object = page.objects.reversed().first(where: { obj in
                    CGRect(x: obj.bounds.x - 5, y: obj.bounds.y - 5, width: obj.bounds.width + 10, height: obj.bounds.height + 10).contains(point)
                }) { onObject?(object) }
            }
        }.accessibilityLabel("\(page.size) 原稿纸张，共 \(page.objects.count) 个可见对象")
    }
    private func drawTemplate(_ context: inout GraphicsContext) {
        let step = 28.0
        switch page.template {
        case "dot":
            for x in stride(from: step, to: page.width, by: step) {
                for y in stride(from: step, to: page.height, by: step) {
                    context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.3, height: 1.3)), with: .color(Palette.line))
                }
            }
        case "ruled", "grid":
            var path = Path()
            for y in stride(from: step, to: page.height, by: step) { path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: page.width, y: y)) }
            if page.template == "grid" {
                for x in stride(from: step, to: page.width, by: step) { path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: page.height)) }
            }
            context.stroke(path, with: .color(Palette.line.opacity(0.65)), lineWidth: 0.6)
        default: break
        }
    }
    private func draw(_ object: CorePaperObject, in context: inout GraphicsContext) {
        let b = object.bounds
        let rect = CGRect(x: b.x, y: b.y, width: b.width, height: max(b.height, 24))
        let color = Color(hex: object.color ?? "39353b")
        if object.kind == "stroke" || (object.kind == "shape" && object.points?.isEmpty == false) {
            let points = object.points ?? []
            let width = object.width ?? 2.4
            if points.count == 1, let point = points.first {
                let radius = width * (0.35 + min(1, max(0, point.pressure)) * 0.9) / 2
                context.fill(Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)), with: .color(color))
            }
            for i in points.indices.dropFirst() {
                let a = points[i - 1], z = points[i]
                var line = Path(); line.move(to: CGPoint(x: a.x, y: a.y)); line.addLine(to: CGPoint(x: z.x, y: z.y))
                let pressure = min(1, max(0, (a.pressure + z.pressure) / 2))
                context.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: width * (0.35 + pressure * 0.9), lineCap: .round))
            }
        } else if object.kind == "image", let image = safeImage(object.data) {
            let ratio = min(rect.width / image.size.width, rect.height / image.size.height)
            let fitted = CGRect(x: rect.midX - image.size.width * ratio / 2, y: rect.midY - image.size.height * ratio / 2,
                                width: image.size.width * ratio, height: image.size.height * ratio)
            context.draw(Image(nsImage: image), in: fitted)
        } else if ["text", "formula", "reference"].contains(object.kind), let text = object.text {
            let fontSize = object.kind == "formula" ? min(32, b.height * 0.56) : min(35, max(14, b.height * 0.55))
            let font: Font = object.kind == "formula" ? .custom("Georgia", size: fontSize) : .system(size: fontSize)
            context.draw(Text(text).font(font).foregroundColor(color), in: rect)
        } else {
            context.stroke(Path(rect), with: .color(Palette.muted), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            context.draw(Text("未覆盖的原生对象").font(.system(size: 14)).foregroundColor(Palette.muted), in: rect.insetBy(dx: 8, dy: 8))
        }
    }
}

func safeImage(_ data: String?) -> NSImage? {
    guard let data, data.range(of: "^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$", options: .regularExpression) != nil,
          let comma = data.firstIndex(of: ","), let bytes = Data(base64Encoded: String(data[data.index(after: comma)...])) else { return nil }
    return NSImage(data: bytes)
}
