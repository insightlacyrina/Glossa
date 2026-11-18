import SwiftUI
import GlossaCore

struct ContentView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var searchFocused: Bool
    @State private var newFolder = false
    @State private var folderName = ""
    var body: some View {
        HStack(spacing: 0) {
            if store.sidebarVisible {
                sidebar.frame(width: 224)
                Rectangle().fill(Palette.line).frame(width: 1)
            }
            VStack(spacing: 0) {
                topbar
                Rectangle().fill(Palette.line).frame(height: 1)
                Group {
                    if store.selection == "review" { ReviewView() }
                    else if store.selection == "proof" { ProofView() }
                    else if let note = store.selectedNote { NoteView(note: note).id(note.id) }
                    else { library }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onChange(of: store.searchFocusRequest) { _, _ in
            let request = store.searchFocusRequest
            Task { @MainActor in
                await Task.yield()
                guard request == store.searchFocusRequest, store.selectedNoteID == nil, store.canNavigate,
                      store.selection == "notes" || store.selection.hasPrefix("folder:") else { return }
                searchFocused = true
            }
        }
        .onChange(of: store.selection) { _, _ in searchFocused = false }
        .onChange(of: store.selectedNoteID) { _, _ in searchFocused = false }
        .background(Palette.background).foregroundStyle(Palette.ink).tint(Palette.plum)
        .overlay(alignment: .bottom) {
            Group {
                if store.importing {
                    HStack(spacing: 14) {
                        ProgressView().controlSize(.small)
                        Text("正在读取工程…").font(.system(size: 12))
                        Button("取消读取") { store.cancelImport() }.buttonStyle(QuietButton())
                    }.padding(16).background(Palette.paper).clipShape(RoundedRectangle(cornerRadius: 8))
                        .shadow(color: Palette.ink.opacity(0.12), radius: 12, y: 3).padding(24)
                        .transition(.opacity)
                }
            }.animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: store.importing)
        }
        .sheet(isPresented: $store.showSettings) { SettingsView().environmentObject(store) }
        .sheet(isPresented: $store.showRecovery) { RecoveryView().environmentObject(store) }
        .alert("操作未完成", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("知道了") { store.errorMessage = nil }
        } message: { Text(store.errorMessage ?? "") }
        .confirmationDialog("导入工程将替换当前工作区", isPresented: Binding(get: { store.pendingImport != nil }, set: { if !$0 { store.pendingImport = nil } })) {
            Button("保存当前恢复副本并导入") { if let url = store.pendingImport { store.importProject(url) } }
            Button("取消", role: .cancel) { store.pendingImport = nil }
        } message: { Text("当前完整工程会保留在本机恢复列表中；同步连接将断开。") }
        .alert("新建文件夹", isPresented: $newFolder) {
            TextField("文件夹名称", text: $folderName)
            Button("创建") { if !folderName.trimmingCharacters(in: .whitespaces).isEmpty { _ = store.action("createFolder", ["name": folderName]) }; folderName = "" }
            Button("取消", role: .cancel) {}
        }
    }
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "text.book.closed").font(.system(size: 30, weight: .ultraLight)).foregroundStyle(Palette.plum)
                VStack(alignment: .leading, spacing: 4) {
                    Text("笺注").font(.custom("Songti SC", size: 27)).tracking(3)
                    Text("G L O S S A").font(.system(size: 9, design: .monospaced)).foregroundStyle(Palette.muted)
                }
            }.padding(.horizontal, 24).padding(.top, 24).padding(.bottom, 24)
            nav("notes", "所有笔记", "square.grid.2x2", count: store.notes.count)
            nav("review", "温故", "sun.max", count: store.snapshot?.dueBlockIDs.count ?? 0)
            nav("proof", "校对", "text.magnifyingglass", count: store.conflicts.count)
            HStack {
                Eyebrow(text: "我的文件夹")
                Spacer()
                Button { newFolder = true } label: {
                    Image(systemName: "plus").font(.system(size: 11))
                        .frame(width: 32, height: 32).contentShape(Rectangle())
                }.buttonStyle(.plain).help("新建文件夹")
            }.padding(.horizontal, 24).padding(.top, 24).padding(.bottom, 8)
            ScrollView {
                VStack(spacing: 3) {
                    ForEach(store.snapshot?.folders ?? []) { folder in nav("folder:" + folder.id, folder.name, "folder") }
                    if store.snapshot?.folders.isEmpty != false {
                        Text("导入笔记后，在这里归档。 ").font(.caption).foregroundStyle(Palette.muted).padding(.horizontal, 24).padding(.top, 6)
                    }
                }
            }
            Spacer(minLength: 20)
            VStack(alignment: .leading, spacing: 0) {
                sidebarAction("导入工程", symbol: "square.and.arrow.down") { store.chooseImport() }.accessibilityIdentifier("import-project")
                sidebarAction("导出完整工程", symbol: "square.and.arrow.up") { store.exportProject() }
                sidebarAction("恢复副本", symbol: "clock.arrow.circlepath") { store.refreshRecoveries(); store.showRecovery = true }
            }.padding(.bottom, 16)
            Divider().overlay(Palette.line)
            Button { store.showSettings = true } label: {
                HStack {
                    Image(systemName: "externaldrive.connected.to.line.below").font(.system(size: 19, weight: .light))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Mac 同步").font(.system(size: 12, weight: .medium))
                        Text(store.syncStatus).font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 9))
                }.frame(maxWidth: .infinity, alignment: .leading).padding(20).contentShape(Rectangle())
            }.buttonStyle(.plain)
        }.background(Palette.sidebar)
    }
    private func nav(_ id: String, _ title: String, _ symbol: String, count: Int? = nil) -> some View {
        let selected = store.selection == id
        return Button {
            searchFocused = false
            store.navigate(to: id)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.system(size: 15, weight: .regular)).frame(width: 20)
                Text(title).font(.body.weight(selected ? .semibold : .regular))
                Spacer()
                if let count, count > 0 { Text("\(count)").font(.caption).monospacedDigit().foregroundStyle(Palette.muted) }
            }.frame(maxWidth: .infinity, minHeight: 36, alignment: .leading).padding(.horizontal, 14)
                .foregroundStyle(selected ? Palette.plum : Palette.ink)
                .background(selected ? Palette.plum.opacity(0.11) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: selected)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).padding(.horizontal, 10)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier("navigation-" + id)
    }
    private func sidebarAction(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol).frame(width: 20)
                Text(title)
                Spacer()
            }.font(.body).frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .padding(.horizontal, 25).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    private var topbar: some View {
        HStack {
            if let note = store.selectedNote, store.selection != "review", store.selection != "proof" {
                Button { store.returnToLibrary() } label: {
                    Image(systemName: "chevron.left").font(.body.weight(.medium)).frame(width: 28, height: 28).contentShape(Rectangle())
                }.buttonStyle(.plain).help("返回笔记列表（⌘[）").accessibilityLabel("返回笔记列表")
                Text(note.title).font(.headline).lineLimit(1).help(note.title)
                Spacer()
                Text(store.status).font(.system(size: 11)).foregroundStyle(Palette.muted)
            } else {
                Text(store.selection == "review" ? "温故" : store.selection == "proof" ? "校对" : folderTitle).font(.headline)
                Spacer()
                if store.selection != "review" && store.selection != "proof" {
                    Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted)
                    TextField("搜索标题、正文与标签", text: $store.search).textFieldStyle(.plain).font(.body).frame(width: 210)
                        .focused($searchFocused).help("搜索笔记（⌘F）")
                        .accessibilityIdentifier("search-notes")
                }
            }
        }.padding(.horizontal, 24).frame(height: 50).background(Palette.sidebar.opacity(0.7))
    }
    private var library: some View {
        Group {
            if store.notes.isEmpty {
                VStack(spacing: 20) {
                    Spacer()
                    PaperMotif().frame(width: 210, height: 195).accessibilityHidden(true)
                    Eyebrow(text: "YOUR THOUGHTS, WITH YOU")
                    Text("把笔记带在身边").font(.custom("Songti SC", size: 30)).tracking(1)
                    Text("从平板带来一份工程，在 Mac 上细读、修订与温习。\n每一处修改，都与原稿相连。")
                        .font(.body).lineSpacing(5).multilineTextAlignment(.center).foregroundStyle(Palette.muted)
                    Button { store.chooseImport() } label: { Label("导入笔记", systemImage: "square.and.arrow.down") }.buttonStyle(PrimaryButton())
                    Text("支持 .glossa 与旧版 .quietpaper 工程").font(.caption).foregroundStyle(Palette.muted)
                    Spacer()
                    Text("原稿留在纸上，思考继续生长。").font(.custom("Songti SC", size: 13)).foregroundStyle(Palette.muted).padding(.bottom, 35)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Eyebrow(text: "A PLACE FOR YOUR THOUGHTS")
                        HStack(alignment: .firstTextBaseline) {
                            Text(folderTitle).font(.custom("Songti SC", size: 28))
                            Text("\(store.filteredNotes.count)").font(.system(size: 13, design: .monospaced)).foregroundStyle(Palette.muted)
                            Spacer()
                            Button { store.chooseImport() } label: { Label("导入笔记", systemImage: "square.and.arrow.down") }.buttonStyle(QuietButton())
                        }
                        if store.filteredNotes.isEmpty {
                            EmptyState(symbol: "magnifyingglass",
                                title: store.search.isEmpty ? "这里还没有笔记" : "没有找到匹配的笔记",
                                message: store.search.isEmpty ? "把已有笔记归入这个文件夹。" : "试试其他关键词，或检查标题、正文与标签。").frame(height: 370)
                        } else {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 250, maximum: 370), spacing: 20)], alignment: .leading, spacing: 20) {
                                ForEach(store.filteredNotes) { note in
                                    Button { store.openNote(note.id) } label: { NoteCard(note: note) }.buttonStyle(.plain)
                                        .accessibilityIdentifier("note-" + note.id)
                                        .help("打开“" + note.title + "”")
                                }
                            }
                        }
                    }.padding(28)
                }
            }
        }
    }
    private var folderTitle: String {
        store.snapshot?.folders.first { "folder:" + $0.id == store.selection }?.name ?? "所有笔记"
    }
}

struct PaperMotif: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 3).fill(Palette.paper.opacity(0.65)).frame(width: 140, height: 184).rotationEffect(.degrees(-12)).offset(x: -24, y: 3)
            VStack(alignment: .leading, spacing: 14) {
                HStack { Image(systemName: "doc.text").font(.system(size: 22, weight: .light)); Spacer() }
                ForEach(0..<4) { i in Rectangle().fill(Palette.plum.opacity(i == 3 ? 0.1 : 0.23)).frame(width: i == 3 ? 56 : 92, height: 1) }
                Spacer()
                HStack { Spacer(); Image(systemName: "line.3.horizontal").font(.system(size: 22, weight: .light)).foregroundStyle(Palette.plum) }
            }.padding(24).frame(width: 149, height: 195).background(Palette.paper)
                .overlay(Rectangle().stroke(Palette.line, lineWidth: 1)).rotationEffect(.degrees(6)).offset(x: 16)
                .shadow(color: Palette.ink.opacity(0.06), radius: 12, y: 8)
        }
    }
}
struct NoteCard: View {
    let note: CoreNote
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let page = note.pages.first { PaperView(page: page).frame(height: 205).clipped() }
            else { Palette.paper.frame(height: 205) }
            Rectangle().fill(Palette.line).frame(height: 1)
            VStack(alignment: .leading, spacing: 11) {
                Text(note.title).font(.custom("Songti SC", size: 21)).lineLimit(1)
                Text(note.tags.map { "#" + $0 }.joined(separator: "  ")).font(.caption).foregroundStyle(Palette.plum).lineLimit(1)
                HStack {
                    Text(Date(timeIntervalSince1970: note.modifiedAt / 1000).formatted(date: .abbreviated, time: .omitted))
                    Spacer(); Text("\(note.pages.count) 页 · \(note.blocks.count) 块")
                }.font(.caption).foregroundStyle(Palette.muted)
            }.padding(20)
        }.background(Palette.paper).clipShape(RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Palette.line))
    }
}
