import AppKit
import SwiftUI
import UniformTypeIdentifiers
import GlossaCore

@MainActor final class WorkspaceStore: ObservableObject {
    @Published var snapshot: CoreSnapshot?
    @Published var selection = "notes"
    @Published var selectedNoteID: String?
    @Published var focusedBlockID: String?
    @Published var blockFocusRequest = UUID()
    @Published var reviewBlockID: String?
    @Published var search = ""
    @Published var searchFocusRequest = UUID()
    @Published var sidebarVisible = true
    @Published var errorMessage: String?
    @Published var status = "本地优先 · 离线可用"
    @Published var syncStatus = "未连接"
    @Published var syncing = false
    @Published var importing = false
    @Published var showSettings = false
    @Published var showRecovery = false
    @Published var pendingImport: URL?
    @Published var syncSettings = SavedSync()
    @Published var token = ""
    @Published var passphrase = ""
    @Published var recoveryFiles: [URL] = []
    private var core: NativeCore?
    private var disk: LocalWorkspace?
    private var saved: SavedWorkspace?
    private var epoch = UUID()
    private var activeToken = ""
    private var activePassphrase = ""
    private var lastProjectionAt = Date.distantPast
    private var initialImportURL: URL?
    private var importRequestID: UUID?
    private var librarySelection = "notes"
    private var librarySearch = ""
    let directory: URL

    init() {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--workspace"), args.indices.contains(i + 1) {
            directory = URL(fileURLWithPath: args[i + 1], isDirectory: true)
        } else {
            directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Glossa", isDirectory: true)
        }
        do {
            let storage = try LocalWorkspace(directory: directory)
            disk = storage
            let previous = try storage.load()
            let device = previous?.deviceID ?? "mac-\(UUID().uuidString)"
            let engine = try NativeCore(deviceID: device)
            if let previous { try engine.loadProject(previous.projectJSON) }
            core = engine
            saved = try previous ?? SavedWorkspace(deviceID: device, projectJSON: engine.projectJSON())
            snapshot = try engine.snapshot()
            syncSettings = saved!.sync
            if !syncSettings.url.isEmpty {
                token = (try? NativeSecrets.token(for: secretAccount(syncSettings))) ?? ""
                activeToken = token
            }
            refreshRecoveries()
            if previous == nil { try storage.save(saved!) }
            if let i = args.firstIndex(of: "--import"), args.indices.contains(i + 1), previous == nil {
                initialImportURL = URL(fileURLWithPath: args[i + 1])
            }
        } catch {
            errorMessage = "资料库未能打开：\(error.localizedDescription)\n原文件已保留，可通过恢复副本或导入工程继续。"
            status = "资料库未打开"
        }
    }
    var notes: [CoreNote] { snapshot?.notes ?? [] }
    var canNavigate: Bool {
        !importing && !showSettings && !showRecovery && pendingImport == nil && errorMessage == nil
            && NSApp.keyWindow?.sheetParent == nil && NSApp.mainWindow?.attachedSheet == nil
            && NSApp.keyWindow?.attachedSheet == nil
    }
    var canReturnToLibrary: Bool { selectedNote != nil && isLibrary(selection) }

    func navigate(to destination: String) {
        guard canNavigate else { return }
        rememberLibrary()
        if isLibrary(destination) {
            if destination != librarySelection { librarySearch = "" }
            librarySelection = destination
            search = librarySearch
        }
        selection = destination; selectedNoteID = nil; focusedBlockID = nil; reviewBlockID = nil
        if destination == "review" { refreshProjection() }
    }

    func openNote(_ noteID: String) {
        guard notes.contains(where: { $0.id == noteID }) else { return }
        rememberLibrary()
        selection = librarySelection; selectedNoteID = noteID; focusedBlockID = nil
    }

    func returnToLibrary() {
        guard canNavigate else { return }
        selection = librarySelection; search = librarySearch
        selectedNoteID = nil; focusedBlockID = nil; reviewBlockID = nil
    }

    func focusSearch() {
        guard canNavigate else { return }
        rememberLibrary()
        returnToLibrary()
        searchFocusRequest = UUID()
    }

    private func isLibrary(_ destination: String) -> Bool {
        destination == "notes" || destination.hasPrefix("folder:")
    }
    private func rememberLibrary() {
        if isLibrary(selection) { librarySelection = selection; librarySearch = search }
    }
    private func resetNavigation(noteID: String?) {
        selection = "notes"; librarySelection = "notes"; search = ""; librarySearch = ""
        selectedNoteID = noteID; focusedBlockID = nil; reviewBlockID = nil
    }
    func openBlock(noteID: String, blockID: String) {
        openNote(noteID); focusedBlockID = blockID; blockFocusRequest = UUID()
    }
    func reviewBlock(_ blockID: String) {
        rememberLibrary()
        reviewBlockID = blockID; refreshProjection(); selection = "review"
    }
    var selectedNote: CoreNote? { notes.first { $0.id == selectedNoteID } }
    var filteredNotes: [CoreNote] {
        notes.filter { note in
            let matchesFolder = !selection.hasPrefix("folder:") || note.folderId == String(selection.dropFirst(7))
            let content = ([note.title] + note.tags + note.blocks.map(\.title) + note.blocks.flatMap { $0.segments.map(\.text) }).joined(separator: " ")
            return matchesFolder && (search.isEmpty || content.localizedCaseInsensitiveContains(search))
        }.sorted { $0.modifiedAt > $1.modifiedAt }
    }
    var conflicts: [CoreConflict] { (snapshot?.conflicts ?? []).filter { $0.resolved != true } }
    var projectID: String {
        guard let text = saved?.projectJSON.data(using: .utf8),
              let data = try? JSONSerialization.jsonObject(with: text) as? [String: Any],
              let project = data["project"] as? [String: Any] else { return "" }
        return project["id"] as? String ?? ""
    }
    var operationCount: Int {
        guard let json = try? operationsJSON(), let data = json.data(using: .utf8),
              let values = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return 0 }
        return values.count
    }
    func correspondence(_ noteID: String, _ contentID: String) -> NativeCorrespondence? {
        guard let core, let json = try? core.invoke("correspondence", ["noteID": noteID, "segmentID": contentID]) else { return nil }
        return try? JSONDecoder().decode(NativeCorrespondence.self, from: Data(json.utf8))
    }
    func operationsJSON() throws -> String {
        guard let saved, let data = saved.projectJSON.data(using: .utf8),
              let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let project = envelope["project"] as? [String: Any], let ops = project["operations"] else {
            throw failure("没有可用工程")
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: ops, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    @discardableResult func action(_ name: String, _ args: [String: Any] = [:]) -> Bool {
        guard let core, let previous = saved, let disk else { return false }
        do {
            _ = try core.invoke(name, args)
            let nextSnapshot = try core.snapshot()
            var next = previous
            next.projectJSON = try core.projectJSON()
            try disk.save(next)
            saved = next; snapshot = nextSnapshot
            status = "已保存到此 Mac"
            return true
        } catch {
            try? core.loadProject(previous.projectJSON)
            errorMessage = error.localizedDescription
            status = "操作未保存 · 输入已保留"
            return false
        }
    }
    func chooseImport() {
        let panel = NSOpenPanel()
        panel.title = "导入笺注工程"
        panel.allowedContentTypes = [.json, UTType(filenameExtension: "glossa") ?? .data,
                                    UTType(filenameExtension: "quietpaper") ?? .data]
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            prepareImport(url)
        }
    }
    func prepareImport(_ url: URL) {
        if operationCount > 0 || !notes.isEmpty || !syncSettings.url.isEmpty { pendingImport = url }
        else { importProject(url) }
    }
    func importProject(_ url: URL) {
        guard let disk else { errorMessage = "当前资料库被另一进程占用，无法导入。"; return }
        let requestID = UUID(), lease = epoch
        importRequestID = requestID; importing = true; status = "正在读取工程…"
        pendingImport = nil
        Task {
            defer { if importRequestID == requestID { importRequestID = nil; importing = false } }
            do {
                let json = try await Task.detached(priority: .userInitiated) {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    return try String(contentsOf: url, encoding: .utf8)
                }.value
                guard importRequestID == requestID else { return }
                guard epoch == lease else { throw failure("读取期间工作区已切换；本次导入已停止。") }
                let device = saved?.deviceID ?? "mac-\(UUID().uuidString)"
                let candidate = try NativeCore(deviceID: device)
                try candidate.loadProject(json)
                let nextSnapshot = try candidate.snapshot()
                let next = SavedWorkspace(deviceID: device, projectJSON: try candidate.projectJSON())
                try disk.preserveCurrent()
                try disk.save(next)
                epoch = UUID(); saved = next; core = candidate; snapshot = nextSnapshot
                syncSettings = next.sync; token = ""; passphrase = ""; activeToken = ""; activePassphrase = ""
                resetNavigation(noteID: nextSnapshot.notes.first?.id)
                status = "工程已导入并保存"; syncStatus = "未连接"
                refreshRecoveries()
            } catch {
                if importRequestID == requestID { errorMessage = "导入失败：\(error.localizedDescription)"; status = "导入未完成" }
            }
        }
    }
    func startInitialImport() {
        if let url = initialImportURL { initialImportURL = nil; prepareImport(url) }
    }
    func cancelImport() {
        importRequestID = nil; importing = false; status = "已取消读取；当前工程保留"
    }
    func exportProject() {
        guard let core else { return }
        do { try export(try core.projectJSON(), name: "笺注工程.glossa", type: .data) }
        catch { errorMessage = error.localizedDescription }
    }
    func exportReading(_ note: CoreNote, html: Bool) {
        guard let core else { return }
        do {
            let result = try core.invoke(html ? "readingHTML" : "markdown", ["noteID": note.id])
            let text = try JSONDecoder().decode(String.self, from: Data(result.utf8))
            let safeName = note.title.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            try export(text, name: safeName + (html ? "-阅读.html" : ".md"), type: html ? .html : .plainText)
        } catch { errorMessage = error.localizedDescription }
    }
    private func export(_ text: String, name: String, type: UTType) throws {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name; panel.allowedContentTypes = [type]
        if panel.runModal() == .OK, let url = panel.url { try Data(text.utf8).write(to: url, options: .atomic) }
    }
    func refreshRecoveries() { recoveryFiles = (try? disk?.recoveryFiles()) ?? [] }
    func exportRecovery(_ url: URL) {
        do {
            guard let recovery = try disk?.readRecovery(url) else { return }
            try export(recovery.projectJSON, name: "笺注恢复.glossa", type: .data)
        } catch { errorMessage = error.localizedDescription }
    }
    func restoreRecovery(_ url: URL) {
        guard let disk else { return }
        do {
            let recovery = try disk.readRecovery(url)
            let device = saved?.deviceID ?? "mac-\(UUID().uuidString)"
            let candidate = try NativeCore(deviceID: device)
            try candidate.loadProject(recovery.projectJSON)
            let state = try candidate.snapshot()
            try disk.preserveCurrent()
            let next = SavedWorkspace(deviceID: device, projectJSON: try candidate.projectJSON())
            try disk.save(next)
            epoch = UUID(); core = candidate; saved = next; snapshot = state
            syncSettings = next.sync; passphrase = ""; token = ""; activeToken = ""; activePassphrase = ""
            resetNavigation(noteID: state.notes.first?.id); status = "已恢复；恢复前内容另存为副本"
            refreshRecoveries(); showRecovery = false
        } catch { errorMessage = error.localizedDescription }
    }
    func resetSyncDraft() {
        syncSettings = saved?.sync ?? SavedSync()
        token = activeToken; passphrase = activePassphrase
    }
    func prefillLocalServer(_ configuration: SyncConfiguration) {
        resetSyncDraft()
        syncSettings.url = configuration.url
        syncSettings.projectID = projectID
        syncSettings.enabled = true
        token = configuration.token
        // Preserve the user's encryption mode and session passphrase for explicit review.
    }
    func aiProxyConfiguration() -> SyncConfiguration? {
        guard let configuration = saved?.sync, configuration.enabled,
              !configuration.url.isEmpty, !activeToken.isEmpty else { return nil }
        return SyncConfiguration(url: configuration.url, token: activeToken,
                                 projectID: projectID, mode: configuration.mode)
    }
    func saveSyncSettings() {
        guard var next = saved, let disk else { return }
        do {
            if syncSettings.projectID.isEmpty { syncSettings.projectID = projectID }
            guard operationCount == 0 || syncSettings.projectID == projectID else { throw failure("工程标识与当前工程不同，请先导入对应工程。") }
            let configChanged = next.sync.url != syncSettings.url || next.sync.projectID != syncSettings.projectID || next.sync.mode != syncSettings.mode
            if configChanged {
                syncSettings.cursor = 0; syncSettings.acknowledgedIDs = []; syncSettings.generation = nil
            } else {
                syncSettings.cursor = next.sync.cursor
                syncSettings.acknowledgedIDs = next.sync.acknowledgedIDs
                syncSettings.generation = next.sync.generation
            }
            try NativeSecrets.setToken(token, for: secretAccount(syncSettings))
            next.sync = syncSettings
            try disk.save(next)
            saved = next; activeToken = token; activePassphrase = passphrase
            epoch = UUID(); syncStatus = syncSettings.enabled ? "等待同步" : "已断开"
            showSettings = false
            if syncSettings.enabled { Task { await synchronize() } }
        } catch { errorMessage = error.localizedDescription }
    }
    func synchronize() async {
        guard !syncing, let previous = saved, previous.sync.enabled,
              let core, let disk else { return }
        if previous.sync.mode == "e2ee" && activePassphrase.isEmpty { syncStatus = "加密工程待解锁"; return }
        let lease = epoch
        syncing = true; syncStatus = "正在同步…"
        defer { syncing = false }
        do {
            let config = SyncConfiguration(url: previous.sync.url, token: activeToken,
                                           projectID: previous.sync.projectID, mode: previous.sync.mode,
                                           passphrase: activePassphrase)
            let result = try await NativeSyncClient().synchronize(configuration: config,
                operationsJSON: operationsJSON(), cursor: previous.sync.cursor,
                acknowledgedIDs: previous.sync.acknowledgedIDs, generation: previous.sync.generation)
            guard lease == epoch else { return }
            guard var current = saved else { return }
            let before = try core.projectJSON()
            do {
                // An empty reader may pull an existing project using its explicit identity.
                if notes.isEmpty && operationCount == 0 && projectID != config.projectID {
                    let ops = try JSONSerialization.jsonObject(with: Data(result.operationsJSON.utf8))
                    let envelope: [String: Any] = ["format": "quiet-paper-project", "version": 1,
                        "project": ["schemaVersion": 1, "id": config.projectID, "operations": ops, "metadata": [:]]]
                    try core.loadProject(String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self))
                } else { try core.mergeOperations(result.operationsJSON) }
                let state = try core.snapshot()
                current.projectJSON = try core.projectJSON()
                current.sync.cursor = result.cursor
                current.sync.acknowledgedIDs = result.acknowledgedIDs
                current.sync.generation = result.generation
                try disk.save(current)
                saved = current; snapshot = state
                if !showSettings { syncSettings = current.sync }
                syncStatus = "已同步 · \(Date().formatted(date: .omitted, time: .shortened))"
            } catch { try? core.loadProject(before); throw error }
        } catch { if lease == epoch { syncStatus = "同步暂停：\(error.localizedDescription)" } }
    }
    func refreshProjection() {
        guard let core else { return }
        do { snapshot = try core.snapshot(); lastProjectionAt = Date() }
        catch { status = "视图刷新失败：\(error.localizedDescription)" }
    }
    func autoSync() async {
        while !Task.isCancelled {
            if Date().timeIntervalSince(lastProjectionAt) >= 60 { refreshProjection() }
            await synchronize()
            do { try await Task.sleep(nanoseconds: 8_000_000_000) } catch { return }
        }
    }
    private func secretAccount(_ config: SavedSync) -> String { config.url + "|" + config.projectID }
    private func failure(_ text: String) -> NSError { NSError(domain: "Glossa", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}

struct NativeCorrespondence: Decodable {
    let status: String
    let objectIds: [String]
    let segmentIds: [String]
    let reason: String?
}
