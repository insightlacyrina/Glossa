import AppKit
import SwiftUI
@main struct Audit {
 @MainActor static func main() {
  let app = NSApplication.shared; app.setActivationPolicy(.regular)
  let store = WorkspaceStore(); store.startInitialImport()
  let mode = ProcessInfo.processInfo.environment["AUDIT_MODE"] ?? "library"
  let window = NSWindow(contentRect:NSRect(x:100,y:100,width:960,height:640),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
  window.animationBehavior = .none
  window.title = "Native source visual audit — \(mode)"
  func show(_ view: AnyView) { window.contentView = NSHostingView(rootView:view.environmentObject(store).preferredColorScheme(.light)); window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps:true) }
  show(AnyView(ContentView()))
  DispatchQueue.main.asyncAfter(deadline:.now()+3) {
   if mode == "review" { store.selection="review" }
   if mode == "proof" { store.selection="proof" }
   if mode == "search" { store.search="没有匹配结果" }
   if mode == "note" || mode == "a" || mode == "b", let n=store.notes.first { store.selectedNoteID=n.id }
   if mode == "settings" { show(AnyView(SettingsView())) }
   if mode == "settings-sheet" { store.showSettings = true }
   if mode == "revision", let n=store.notes.first, let seg=n.blocks.first?.segments.first { show(AnyView(SegmentEditor(noteID:n.id, segment:seg))) }
   if mode == "recovery" { show(AnyView(RecoveryView())) }
   if mode == "manage", let n=store.notes.first { show(AnyView(ManageNoteView(note:n))) }
   if mode == "history", let n=store.notes.first { show(AnyView(HistoryView(note:n))) }
   DispatchQueue.main.asyncAfter(deadline:.now()+5) {
    let p=Process(); p.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture"); p.arguments=["-x","-l",String(window.windowNumber),"/Users/zhuyongfei/Documents/ChatGPT/Glossa/docs/verification/release-2026-10-27/visual-macos/harness-\(mode).png"]; try? p.run(); p.waitUntilExit(); app.terminate(nil)
   }
  }; app.run()
 }
}
