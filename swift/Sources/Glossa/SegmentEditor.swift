import SwiftUI
import AppKit
import GlossaCore

struct SegmentEditor: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.dismiss) var dismiss
    let noteID: String
    let segment: CoreSegment
    @State private var draft: String
    @State private var edits: [[String: Any]] = []
    @State private var discard = false
    init(noteID: String, segment: CoreSegment) {
        self.noteID = noteID; self.segment = segment
        _draft = State(initialValue: segment.text)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Eyebrow(text: "A CAREFUL REVISION")
            Text(segment.kind == "formula" ? "修订公式" : "修订这段内容").font(.custom("Songti SC", size: 28))
            Text("修改保留稳定字符身份，并在原位置生成独立修订层。已有确认字形时使用仿手写，缺字时保留印刷文字。公式按原文保存。")
                .font(.system(size: 12)).foregroundStyle(Palette.muted).lineSpacing(5)
            NativeTextEditor(text: $draft, monospaced: segment.kind == "formula") { before, range, replacement in
                let utf16 = Array(before.utf16)
                func isBoundary(_ position: Int) -> Bool {
                    position <= 0 || position >= utf16.count || !(0xD800...0xDBFF).contains(utf16[position - 1]) || !(0xDC00...0xDFFF).contains(utf16[position])
                }
                guard range.location != NSNotFound, range.location + range.length <= utf16.count,
                      isBoundary(range.location), isBoundary(range.location + range.length) else { return false }
                let native = before as NSString
                let start = native.substring(to: range.location).unicodeScalars.count
                let end = native.substring(to: range.location + range.length).unicodeScalars.count
                edits.append(["start": start, "end": end, "text": replacement, "expectedText": before])
                return true
            }.frame(minHeight: 240).overlay(RoundedRectangle(cornerRadius: 5).stroke(Palette.line))
                .accessibilityIdentifier("segment-editor")
            HStack {
                Text("\(draft.unicodeScalars.count) 字符").font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted)
                Spacer()
                Button("取消") { if draft != segment.text { discard = true } else { dismiss() } }.keyboardShortcut(.cancelAction)
                Button("保存修订") {
                    if store.action("editRanges", ["noteID": noteID, "segmentID": segment.id,
                        "expectedText": segment.text, "expectedResult": draft,
                        "expectedCharacters": segment.chars.filter { !$0.deleted }.map { ["id": $0.id, "version": $0.version, "value": $0.value] },
                        "edits": edits]) { dismiss() }
                }.buttonStyle(PrimaryButton()).keyboardShortcut("s", modifiers: .command).disabled(edits.isEmpty || draft == segment.text)
                    .accessibilityIdentifier("save-revision")
            }
        }.padding(32).frame(width: 660, height: 490).background(Palette.paper)
            .interactiveDismissDisabled(draft != segment.text)
            .confirmationDialog("放弃未保存的修订？", isPresented: $discard) {
                Button("放弃修改", role: .destructive) { dismiss() }
                Button("继续编辑", role: .cancel) {}
            }
    }
}

struct NativeTextEditor: NSViewRepresentable {
    @Binding var text: String
    var monospaced: Bool
    var willChange: ((String, NSRange, String) -> Bool)?
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .noBorder
        let view = NSTextView()
        view.isRichText = false; view.importsGraphics = false; view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false; view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false; view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.font = monospaced ? .monospacedSystemFont(ofSize: 16, weight: .regular) : .systemFont(ofSize: 16)
        view.textColor = NSColor(Palette.ink); view.backgroundColor = NSColor(Palette.paper)
        view.textContainerInset = NSSize(width: 16, height: 17)
        view.autoresizingMask = [.width]; view.isVerticallyResizable = true; view.isHorizontallyResizable = false
        view.textContainer?.widthTracksTextView = true
        view.string = text; view.delegate = context.coordinator
        view.setAccessibilityIdentifier("native-segment-text")
        scroll.documentView = view
        return scroll
    }
    func updateNSView(_ nsView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = nsView.documentView as? NSTextView else { return }
        if view.string != text { view.string = text }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeTextEditor
        init(_ parent: NativeTextEditor) { self.parent = parent }
        func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
            guard let replacementString else { return true }
            return parent.willChange?(textView.string, affectedCharRange, replacementString) ?? true
        }
        func textDidChange(_ notification: Notification) {
            if let view = notification.object as? NSTextView { parent.text = view.string }
        }
    }
}
