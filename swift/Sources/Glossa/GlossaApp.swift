import SwiftUI
import AppKit

@main struct GlossaApp: App {
    @StateObject private var store = WorkspaceStore()
    @AppStorage("glossa.appearance") private var appearance = "light"
    var body: some Scene {
        Window("笺注 · Glossa", id: "workspace") {
            ContentView().environmentObject(store)
                .frame(minWidth: 960, minHeight: 640)
                .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
                .task { store.startInitialImport(); await store.autoSync() }
                .onOpenURL { url in
                    if store.notes.isEmpty { store.importProject(url) } else { store.pendingImport = url }
                }
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in
                    store.refreshProjection()
                    Task { await store.synchronize() }
                }
        }
        .defaultSize(width: 1260, height: 820)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("导入工程…") { store.chooseImport() }.keyboardShortcut("o")
                Button("导出完整工程…") { store.exportProject() }.keyboardShortcut("s", modifiers: [.command, .shift])
                Divider()
                Button("恢复副本…") { store.refreshRecoveries(); store.showRecovery = true }
            }
            CommandGroup(replacing: .appSettings) {
                Button("Mac 同步设置…") { store.showSettings = true }.keyboardShortcut(",")
            }
            CommandGroup(after: .textEditing) {
                Button("搜索笔记") { store.focusSearch() }.keyboardShortcut("f")
                    .disabled(!store.canNavigate)
            }
            CommandGroup(after: .sidebar) {
                Button(store.sidebarVisible ? "隐藏边栏" : "显示边栏") {
                    if store.canNavigate { store.sidebarVisible.toggle() }
                }.keyboardShortcut("s", modifiers: [.command, .control]).disabled(!store.canNavigate)
            }
            CommandMenu("前往") {
                Button("返回笔记列表") { store.returnToLibrary() }.keyboardShortcut("[")
                    .disabled(!store.canNavigate || !store.canReturnToLibrary)
                Divider()
                Button("所有笔记") { store.navigate(to: "notes") }.keyboardShortcut("1").disabled(!store.canNavigate)
                Button("温故") { store.navigate(to: "review") }.keyboardShortcut("2").disabled(!store.canNavigate)
                Button("校对") { store.navigate(to: "proof") }.keyboardShortcut("3").disabled(!store.canNavigate)
            }
        }
    }
}
