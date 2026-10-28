import SwiftUI
import GlossaCore

struct NoteView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let note: CoreNote
    @State private var mode = "split"
    @State private var editing: CoreSegment?
    @State private var managing = false
    @State private var history = false
    @State private var showAIProxy = false
    @State private var aiConfiguration: SyncConfiguration?
    @State private var highlight: Set<String> = []
    @State private var selectedSegment: String?
    @State private var targetPage: String?
    var body: some View {
        VStack(spacing: 0) {
            readingToolbar
            HStack(spacing: 0) {
                if mode != "b" { paperPane.frame(maxWidth: .infinity) }
                if mode == "split" { Rectangle().fill(Palette.line).frame(width: 1) }
                if mode != "a" { structurePane.frame(maxWidth: mode == "split" ? 390 : .infinity) }
            }.frame(maxHeight: .infinity)
        }
        .sheet(item: $editing) { segment in SegmentEditor(noteID: note.id, segment: segment).environmentObject(store) }
        .sheet(isPresented: $managing) { ManageNoteView(note: note).environmentObject(store) }
        .sheet(isPresented: $history) { HistoryView(note: note).environmentObject(store) }
        .sheet(isPresented: $showAIProxy) {
            if let configuration = aiConfiguration { AIProxyView(note: note, configuration: configuration) }
        }
    }
    private var readingToolbar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                readingPicker
                Spacer(minLength: 16)
                noteActions.labelStyle(.titleAndIcon)
            }
            HStack(spacing: 12) {
                readingPicker
                Spacer(minLength: 12)
                noteActions.labelStyle(.iconOnly)
            }
        }
        .controlSize(.small)
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(Palette.sidebar)
        .overlay(alignment: .bottom) { Divider() }
    }
    private var readingPicker: some View {
        Picker("阅读方式", selection: $mode) {
            Text("原稿 A").tag("a"); Text("对照").tag("split"); Text("结构 B").tag("b")
        }.pickerStyle(.segmented).labelsHidden().frame(width: 220)
    }
    private var noteActions: some View {
        Group {
            Button {
                if let configuration = store.aiProxyConfiguration() {
                    aiConfiguration = configuration; showAIProxy = true
                } else { store.showSettings = true }
            } label: { Label("临时 AI 转录", systemImage: "sparkles") }
                .help("临时 AI 转录")
            Button { history = true } label: { Label("修订与历史", systemImage: "clock") }
                .help("修订与历史")
            Button { managing = true } label: { Label("管理", systemImage: "slider.horizontal.3") }
                .help("管理笔记")
            Menu {
                Button("完整工程 .glossa") { store.exportProject() }
                Button("本篇 B 阅读快照 · HTML") { store.exportReading(note, html: true) }
                Button("本篇 B 阅读快照 · Markdown") { store.exportReading(note, html: false) }
            } label: { Label("导出", systemImage: "square.and.arrow.up") }
                .menuStyle(.borderlessButton).fixedSize().help("导出笔记")
        }.buttonStyle(.borderless).font(.system(size: 12))
    }
    private func scroll(_ proxy: ScrollViewProxy, to id: String, anchor: UnitPoint) {
        if reduceMotion { proxy.scrollTo(id, anchor: anchor) }
        else { withAnimation(.easeOut(duration: 0.16)) { proxy.scrollTo(id, anchor: anchor) } }
    }
    private var paperPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 20) {
                    HStack { Eyebrow(text: "A / TRUE TO THE SOURCE"); Spacer(); Text("\(note.pages.count) 页").font(.system(size: 11)).foregroundStyle(Palette.muted) }
                    ForEach(Array(note.pages.enumerated()), id: \.element.id) { index, page in
                        VStack(spacing: 10) {
                            PaperView(page: page, highlighted: highlight) { object in focus(object) }
                                .aspectRatio(page.width / page.height, contentMode: .fit)
                                .background(Palette.paper).shadow(color: Palette.ink.opacity(0.08), radius: 8, y: 3)
                                .overlay(Rectangle().stroke(Palette.line, lineWidth: 0.7))
                            Text("\(index + 1) / \(note.pages.count)  ·  \(page.size)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted)
                        }.id(page.id)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 18)
            }.onChange(of: targetPage) { _, page in if let page { scroll(proxy, to: page, anchor: .top) } }
        }
    }
    private var structurePane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Eyebrow(text: "B / THOUGHTS IN ORDER")
                    Text(note.title).font(.title2.weight(.semibold))
                    if note.blocks.isEmpty {
                        Text("这份原稿还没有整理成知识块。\n在平板中创建对应结构后，它会随工程同步到这里。")
                            .font(.system(size: 13)).foregroundStyle(Palette.muted).lineSpacing(5).padding(.top, 8)
                    }
                    ForEach(Array(note.blocks.enumerated()), id: \.element.id) { index, block in
                        VStack(alignment: .leading, spacing: 14) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(String(format: "%02d", index + 1)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted)
                                Text(block.title).font(.headline)
                                Spacer()
                                Button { store.reviewBlock(block.id) } label: { Image(systemName: "sun.max") }.buttonStyle(.plain).help("温习知识块")
                            }
                            ForEach(block.segments.filter { $0.deleted != true }) { segment in
                                VStack(alignment: .leading, spacing: 10) {
                                    if segment.kind == "reference" {
                                        referencePreview(segment)
                                    } else {
                                        Text(segment.text.isEmpty ? "空白内容" : segment.text)
                                            .font(segment.kind == "formula" ? .system(size: 16, design: .monospaced) : .system(size: 14))
                                            .lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    HStack {
                                        Button { locate(segment) } label: {
                                            Label(segment.source.status == "exact" ? "查看原稿" : "对应待校对", systemImage: segment.source.status == "exact" ? "arrow.left.and.right" : "questionmark.circle")
                                        }.disabled(segment.source.objectIds.isEmpty)
                                        Spacer()
                                        if segment.kind != "reference" {
                                            Button { editing = segment } label: { Label("修订", systemImage: "pencil.line") }
                                                .accessibilityIdentifier("edit-" + segment.id)
                                        }
                                    }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Palette.plum)
                                }.padding(12).background(selectedSegment == segment.id ? Palette.plum.opacity(0.065) : .clear)
                                    .overlay(alignment: .leading) { if selectedSegment == segment.id { Rectangle().fill(Palette.plum).frame(width: 2) } }
                                    .id(segment.id)
                            }
                            if !block.relatedBlockIds.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    Eyebrow(text: "相互关联")
                                    ForEach(block.relatedBlockIds, id: \.self) { id in
                                        if let target = store.notes.first(where: { $0.blocks.contains { $0.id == id } }), let related = target.blocks.first(where: { $0.id == id }) {
                                            Button { store.openBlock(noteID: target.id, blockID: id) } label: { Label(related.title + " · " + target.title, systemImage: "arrow.up.right") }
                                                .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Palette.plum)
                                        }
                                    }
                                }
                            }
                        }.id(block.id)
                        Divider().overlay(Palette.line)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 18)
            }.background(Palette.paper.opacity(0.55))
                .onChange(of: selectedSegment) { _, id in if let id { scroll(proxy, to: id, anchor: .center) } }
                .onChange(of: store.blockFocusRequest) { _, _ in
                    if let id = store.focusedBlockID { scroll(proxy, to: id, anchor: .top) }
                }
                .onAppear {
                    if let id = store.focusedBlockID { proxy.scrollTo(id, anchor: .top) }
                }
        }
    }
    @ViewBuilder private func referencePreview(_ segment: CoreSegment) -> some View {
        let ids = store.correspondence(note.id, segment.id)?.objectIds ?? segment.source.objectIds
        if let image = safeImage(segment.preview) { Image(nsImage: image).resizable().scaledToFit() }
        ForEach(note.pages.filter { page in page.objects.contains { ids.contains($0.id) } }) { page in
            PaperView(page: page, highlighted: Set(ids)).aspectRatio(page.width / page.height, contentMode: .fit).frame(maxHeight: 250)
        }
        if segment.source.objectIds.isEmpty && safeImage(segment.preview) == nil {
            Label("当前工程没有可用的原稿预览", systemImage: "doc.questionmark").font(.system(size: 12)).foregroundStyle(Palette.muted)
        }
        if !segment.text.isEmpty { Text(segment.text).font(.system(size: 13)).textSelection(.enabled) }
    }
    private func locate(_ segment: CoreSegment) {
        selectedSegment = segment.id
        highlight = Set(store.correspondence(note.id, segment.id)?.objectIds ?? segment.source.objectIds)
        targetPage = note.pages.first { page in page.objects.contains { highlight.contains($0.id) || !(Set($0.replacesObjectIds ?? []).intersection(highlight)).isEmpty } }?.id
        if mode == "b" { mode = "split" }
    }
    private func focus(_ object: CorePaperObject) {
        let ids = store.correspondence(note.id, object.id)?.segmentIds ?? []
        if let segment = note.blocks.flatMap(\.segments).first(where: { ids.contains($0.id) && $0.deleted != true }) {
            locate(segment)
            if mode == "a" { mode = "split" }
        }
    }
}

struct ManageNoteView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.dismiss) var dismiss
    let note: CoreNote
    @State private var title: String
    @State private var tags: String
    @State private var folderID: String
    init(note: CoreNote) {
        self.note = note
        _title = State(initialValue: note.title); _tags = State(initialValue: note.tags.joined(separator: ", "))
        _folderID = State(initialValue: note.folderId ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("整理这篇笔记").font(.title2.weight(.semibold))
            Form {
                TextField("标题", text: $title)
                Picker("文件夹", selection: $folderID) {
                    Text("未归档").tag("")
                    ForEach(store.snapshot?.folders ?? []) { Text($0.name).tag($0.id) }
                }
                TextField("标签，以逗号分隔", text: $tags)
            }.formStyle(.columns).fixedSize(horizontal: false, vertical: true)
            HStack { Spacer(); Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    if store.action("manageNote", ["noteID": note.id, "title": title,
                        "folderId": folderID.isEmpty ? NSNull() : folderID as Any,
                        "tags": tags.replacingOccurrences(of: "，", with: ",").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }]) { dismiss() }
                }.buttonStyle(PrimaryButton()).disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }.padding(24).frame(width: 480).background(Palette.paper)
    }
}

struct HistoryView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.dismiss) var dismiss
    let note: CoreNote
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("修订与历史").font(.title2.weight(.semibold)); Spacer(); Button("完成") { dismiss() } }
            Text("B 修订保存为原位置的独立仿手写或印刷层。补充字形、重试、撤销或合并修订请在平板完成。").font(.system(size: 13)).lineSpacing(4).foregroundStyle(Palette.muted)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach((store.snapshot?.corrections ?? []).filter { $0.noteId == note.id }) { correction in
                        VStack(alignment: .leading, spacing: 9) {
                            Label(correction.needsPlacement == true ? "待平板定位" : (correction.mode == "handwriting" ? "仿手写修订层" : "印刷修订层"), systemImage: "square.3.layers.3d").font(.system(size: 11)).foregroundStyle(Palette.plum)
                            Text(correction.before).strikethrough().foregroundStyle(Palette.muted)
                            Text(correction.after)
                            Text(correction.reason).font(.system(size: 11)).foregroundStyle(Palette.muted)
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Palette.background.opacity(0.6)).textSelection(.enabled)
                    }
                    ForEach(note.blocks) { block in
                        Text(block.title).font(.headline)
                        ForEach(Array(block.versions.reversed().enumerated()), id: \.offset) { _, version in
                            VStack(alignment: .leading, spacing: 7) {
                                Text(Date(timeIntervalSince1970: version.at / 1000).formatted()).font(.system(size: 11)).foregroundStyle(Palette.muted)
                                Text(version.text).font(.system(size: 13)).textSelection(.enabled)
                            }.padding(.vertical, 6)
                        }
                    }
                }
            }
        }.padding(24).frame(width: 620, height: 550).background(Palette.paper)
    }
}
