import Foundation
import Darwin

public struct SavedSync: Codable, Equatable {
    public var url = ""
    public var projectID = ""
    public var mode = "plain"
    public var cursor = 0
    public var acknowledgedIDs: [String] = []
    public var generation: String?
    public var enabled = false
    public init() {}
}

public struct SavedWorkspace: Codable {
    public var version = 1
    public var deviceID: String
    public var projectJSON: String
    public var sync: SavedSync
    public init(deviceID: String, projectJSON: String, sync: SavedSync = SavedSync()) {
        self.deviceID = deviceID
        self.projectJSON = projectJSON
        self.sync = sync
    }
}

/// One process owns a workspace. The project and sync acknowledgements commit together.
public final class LocalWorkspace {
    public let directory: URL
    private var lockFD: Int32 = -1
    private var fileURL: URL { directory.appendingPathComponent("workspace.json") }
    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let lockURL = directory.appendingPathComponent("workspace.lock")
        lockFD = open(lockURL.path, O_CREAT | O_RDWR, 0o600)
        guard lockFD >= 0 else { throw Self.error("无法创建资料库锁") }
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            close(lockFD); lockFD = -1
            throw Self.error("资料库已在另一个笺注进程中打开，请先关闭该窗口。")
        }
    }
    deinit { if lockFD >= 0 { flock(lockFD, LOCK_UN); close(lockFD) } }
    public func load() throws -> SavedWorkspace? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let saved = try JSONDecoder().decode(SavedWorkspace.self, from: Data(contentsOf: fileURL))
        guard saved.version == 1 else { throw Self.error("不支持的本地资料库版本；原文件已保留。") }
        return saved
    }
    public func save(_ workspace: SavedWorkspace) throws {
        let data = try JSONEncoder().encode(workspace)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        let handle = try FileHandle(forWritingTo: fileURL)
        defer { try? handle.close() }
        try handle.synchronize()
        let fd = open(directory.path, O_RDONLY)
        guard fd >= 0 else { throw Self.error("无法确认资料库目录写入") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw Self.error("资料库写入未获确认") }
    }
    @discardableResult public func preserveCurrent() throws -> URL? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let folder = directory.appendingPathComponent("Recovery", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let target = folder.appendingPathComponent("\(stamp)-\(UUID().uuidString.prefix(8)).json")
        try FileManager.default.copyItem(at: fileURL, to: target)
        let handle = try FileHandle(forWritingTo: target)
        defer { try? handle.close() }
        try handle.synchronize()
        let fd = open(folder.path, O_RDONLY)
        guard fd >= 0 else { throw Self.error("无法确认恢复副本目录") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw Self.error("恢复副本写入未获确认；当前工程未替换") }
        let parent = open(directory.path, O_RDONLY)
        guard parent >= 0 else { throw Self.error("无法确认资料库目录") }
        defer { close(parent) }
        guard fsync(parent) == 0 else { throw Self.error("恢复目录写入未获确认；当前工程未替换") }
        return target
    }
    public func recoveryFiles() throws -> [URL] {
        let folder = directory.appendingPathComponent("Recovery", isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
    }
    public func readRecovery(_ url: URL) throws -> SavedWorkspace {
        guard url.deletingLastPathComponent().standardizedFileURL == directory.appendingPathComponent("Recovery").standardizedFileURL else {
            throw Self.error("无效的恢复副本")
        }
        return try JSONDecoder().decode(SavedWorkspace.self, from: Data(contentsOf: url))
    }
    private static func error(_ message: String) -> NSError {
        NSError(domain: "Glossa.Workspace", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
