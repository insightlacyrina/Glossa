import SwiftUI
import GlossaCore

struct ReviewView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var all = false
    @State private var cardID: String?
    @State private var mode = "b"
    @State private var settings = false
    var cards: [CoreReviewCard] {
        let cards = store.snapshot?.reviewCards ?? []
        return all ? cards : (store.snapshot?.dueBlockIDs ?? []).compactMap { id in cards.first { $0.blockId == id } }
    }
    var current: CoreReviewCard? { cards.first { $0.blockId == cardID } ?? cards.first }
    private var selectionAnimation: Animation? { reduceMotion ? nil : .easeOut(duration: 0.14) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .bottom, spacing: 16) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("REVISIT & REMEMBER").font(.system(size: 11, weight: .medium, design: .monospaced))
                        .tracking(1.2).foregroundStyle(Palette.muted)
                    Text("温故，知新。").font(.custom("Songti SC", size: 28)).foregroundStyle(Palette.ink)
                }
                Spacer()
                Button { settings = true } label: { Label("复习设置", systemImage: "calendar") }
                    .buttonStyle(QuietButton()).font(.body)
            }
            Picker("范围", selection: $all) {
                Text("今日待复习 · \(store.snapshot?.dueBlockIDs.count ?? 0)").tag(false)
                Text("全部复习内容 · \(store.snapshot?.reviewCards.count ?? 0)").tag(true)
            }.pickerStyle(.segmented).labelsHidden().accessibilityLabel("复习范围").frame(width: 330)
            if let card = current, let note = store.notes.first(where: { $0.id == card.noteId }),
               let block = note.blocks.first(where: { $0.id == card.blockId }) {
                HStack(alignment: .top, spacing: 18) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(cards) { item in
                                let selected = item.blockId == card.blockId
                                Button { cardID = item.blockId } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(title(item)).font(.body).fontWeight(selected ? .semibold : .regular).lineLimit(2)
                                        Text("\(item.reviews) 次 · " + Date(timeIntervalSince1970: item.dueAt / 1000).formatted(date: .abbreviated, time: .omitted))
                                            .font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(1)
                                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                        .foregroundStyle(Palette.ink)
                                        .background {
                                            RoundedRectangle(cornerRadius: 5)
                                                .fill(selected ? Palette.plum.opacity(0.13) : .clear)
                                                .animation(selectionAnimation, value: selected)
                                        }
                                        .overlay {
                                            RoundedRectangle(cornerRadius: 5)
                                                .stroke(selected ? Palette.plum.opacity(0.5) : .clear, lineWidth: 1)
                                                .animation(selectionAnimation, value: selected)
                                        }
                                        .contentShape(RoundedRectangle(cornerRadius: 5))
                                }.buttonStyle(.plain)
                                    .accessibilityAddTraits(selected ? .isSelected : [])
                                    .accessibilityIdentifier("review-card-" + item.blockId)
                            }
                        }.padding(1)
                    }.frame(width: 180)
                    VStack(spacing: 0) {
                        HStack(spacing: 12) {
                            ZStack(alignment: .leading) {
                                Text(block.title).font(.custom("Songti SC", size: 21)).lineLimit(1)
                                    .id(card.blockId).transition(.opacity)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                                .animation(selectionAnimation, value: card.blockId)
                            Picker("复习方式", selection: $mode) { Text("原稿").tag("a"); Text("对照").tag("split"); Text("整理").tag("b") }
                                .pickerStyle(.segmented).labelsHidden().frame(width: 145)
                        }.padding(16)
                        Divider()
                        ScrollView {
                            HStack(alignment: .top, spacing: 18) {
                                if mode != "b" {
                                    VStack(spacing: 14) {
                                        ForEach(note.pages.filter { block.pageIds.contains($0.id) }) { page in
                                            PaperView(page: page, highlighted: Set(block.objectIds)).aspectRatio(page.width / page.height, contentMode: .fit)
                                                .transaction { $0.animation = nil }
                                        }
                                    }.frame(maxWidth: .infinity)
                                }
                                if mode != "a" {
                                    VStack(alignment: .leading, spacing: 18) {
                                        ForEach(block.segments.filter { $0.deleted != true }) { segment in
                                            Text(segment.text).font(segment.kind == "formula" ? .system(.body, design: .monospaced) : .body)
                                                .lineSpacing(5).textSelection(.enabled)
                                            if segment.kind == "reference" {
                                                ForEach(note.pages.filter { page in page.objects.contains { segment.source.objectIds.contains($0.id) } }) { page in
                                                    PaperView(page: page, highlighted: Set(segment.source.objectIds)).aspectRatio(page.width / page.height, contentMode: .fit)
                                                        .transaction { $0.animation = nil }
                                                }
                                            }
                                        }
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }.padding(20)
                        }
                        Divider()
                        HStack(spacing: 10) {
                            Text("凭自己的理解，自评这一块。 ").font(.system(size: 11)).foregroundStyle(Palette.muted)
                                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 6)
                            Button("未掌握") { assess(card, known: false) }.buttonStyle(ReviewAssessmentStyle(known: false))
                                .fixedSize().layoutPriority(1)
                            Button("已掌握") { assess(card, known: true) }.buttonStyle(ReviewAssessmentStyle(known: true)).accessibilityIdentifier("review-known")
                                .fixedSize().layoutPriority(1)
                        }.padding(16)
                    }.background(Palette.paper).clipShape(RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Palette.line))
                }
            } else {
                EmptyState(symbol: "sun.horizon", title: (store.snapshot?.reviewCards.isEmpty ?? true) ? "让知识慢慢沉淀" : "今日暂无待复习",
                           message: (store.snapshot?.reviewCards.isEmpty ?? true) ? "导入含有知识块的笔记后，温习会从这里开始。" : "可以切换到全部复习内容，按自己的节奏回看。")
            }
        }.padding(24)
            .sheet(isPresented: $settings) { ReviewSettingsView().environmentObject(store) }
            .onAppear {
                if let id = store.reviewBlockID { all = true; cardID = id }
            }
    }
    private func title(_ card: CoreReviewCard) -> String { store.notes.first { $0.id == card.noteId }?.blocks.first { $0.id == card.blockId }?.title ?? "知识块" }
    private func assess(_ card: CoreReviewCard, known: Bool) {
        if store.action("review", ["blockID": card.blockId, "rating": known]) { cardID = nil }
    }
}

private struct ReviewAssessmentStyle: ButtonStyle {
    let known: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .frame(width: 100, height: 38)
            .foregroundStyle(known ? Palette.paper : Palette.plum)
            .background(known ? Palette.plum.opacity(configuration.isPressed ? 0.8 : 1) : (configuration.isPressed ? Palette.line : Palette.paper))
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(known ? Palette.plum : Palette.line))
            .contentShape(RoundedRectangle(cornerRadius: 5))
    }
}

struct ProofView: View {
    @EnvironmentObject var store: WorkspaceStore
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 7) {
                Text("FAITHFUL TO EVERY THOUGHT").font(.system(size: 11, weight: .medium, design: .monospaced))
                    .tracking(1.2).foregroundStyle(Palette.muted)
                Text("留给确定的那一刻").font(.custom("Songti SC", size: 28)).foregroundStyle(Palette.ink)
            }
            if store.conflicts.isEmpty {
                EmptyState(symbol: "text.magnifyingglass", title: "当前没有内容冲突", message: "同时修改同一内容产生的不同版本会在这里保留。原稿映射、识别候选与修订落点仍由平板校对。")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(store.conflicts) { conflict in
                            VStack(alignment: .leading, spacing: 16) {
                                Text(store.notes.first { $0.id == conflict.noteId }?.title ?? "内容冲突").font(.custom("Songti SC", size: 21))
                                HStack(alignment: .top, spacing: 16) {
                                    conflictVersion(conflict, text: conflict.current, label: "当前版本", choice: "current")
                                    conflictVersion(conflict, text: conflict.incoming, label: "收到的版本", choice: "incoming")
                                }
                                if ["object", "structure"].contains(conflict.kind) {
                                    Text("这项原稿或结构冲突须在 Android 平板解决。").font(.system(size: 11)).foregroundStyle(Palette.muted)
                                }
                            }.padding(20).background(Palette.paper).overlay(RoundedRectangle(cornerRadius: 5).stroke(Palette.line))
                        }
                    }
                }
            }
        }.padding(24)
    }
    private func conflictVersion(_ conflict: CoreConflict, text: String, label: String, choice: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.muted)
            Text(text).font(.body).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            Button("保留这个版本") { _ = store.action("resolveConflict", ["id": conflict.id, "choice": choice]) }
                .buttonStyle(QuietButton()).disabled(["object", "structure"].contains(conflict.kind))
        }.padding(16).frame(maxWidth: .infinity).background(Palette.background.opacity(0.4))
    }
}
