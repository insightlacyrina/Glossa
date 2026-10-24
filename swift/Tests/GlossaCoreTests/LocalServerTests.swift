import Foundation
import Testing
@testable import GlossaCore

struct LocalServerTests {
    @MainActor @Test func initializationUsesPrivateSeparateDirectoryAndNeverEnablesLoginImplicitly() async throws {
        let fixture = try ServerControllerFixture()
        defer { fixture.remove() }
        await fixture.controller.initialize(port: 18787)
        #expect(fixture.controller.initialized)
        #expect(!fixture.controller.isRunning)
        #expect(fixture.controller.projects.first?.mode == "e2ee")
        #expect(!FileManager.default.fileExists(atPath: fixture.controller.loginAgentURL.path))
        let config = try fixture.configuration()
        #expect(config.token != config.adminToken)
        #expect(config.token.count == 64)
        #expect(config.dataDir.hasPrefix(fixture.directory.path))
        let permissions = try FileManager.default.attributesOfItem(atPath: fixture.controller.configURL.path)[.posixPermissions] as? NSNumber
        #expect((permissions?.intValue ?? 0) & 0o777 == 0o600)
        let plist = try String(contentsOf: fixture.controller.servicePlistURL, encoding: .utf8)
        #expect(!plist.contains(config.token))
        #expect(!plist.contains(config.adminToken))
        await fixture.controller.setLoginEnabled(true)
        #expect(fixture.controller.loginEnabled)
        #expect(FileManager.default.fileExists(atPath: fixture.controller.loginAgentURL.path))
        await fixture.controller.setLoginEnabled(false)
        #expect(!fixture.controller.loginEnabled)
        #expect(!FileManager.default.fileExists(atPath: fixture.controller.loginAgentURL.path))
    }

    @MainActor @Test func initializationRefusesExistingServerDataWithoutOverwritingIt() async throws {
        let fixture = try ServerControllerFixture()
        defer { fixture.remove() }
        try FileManager.default.createDirectory(at: fixture.controller.dataDirectory, withIntermediateDirectories: true)
        let original = fixture.controller.dataDirectory.appendingPathComponent("quiet-paper.sqlite")
        try Data("existing archive".utf8).write(to: original)
        await fixture.controller.initialize()
        #expect(!fixture.controller.initialized)
        #expect(fixture.controller.errorMessage != nil)
        #expect(try String(contentsOf: original, encoding: .utf8) == "existing archive")
        #expect(!FileManager.default.fileExists(atPath: fixture.controller.configURL.path))
    }

    @MainActor @Test func initializationCanRetryAfterPostCopyFilesystemFailure() async throws {
        let fixture = try ServerControllerFixture()
        defer { fixture.remove() }
        try FileManager.default.createDirectory(at: fixture.controller.rootDirectory, withIntermediateDirectories: true)
        // The runtime copy succeeds before the logs-directory operation reaches
        // this unrelated file. No stubbed filesystem or synthetic error is used.
        let blocker = fixture.controller.logDirectory
        try Data("preserve this existing file".utf8).write(to: blocker)
        let installedRuntime = fixture.controller.rootDirectory.appendingPathComponent("runtime")
        await fixture.controller.initialize()
        #expect(fixture.controller.errorMessage != nil)
        #expect(!fixture.controller.initialized)
        #expect(!FileManager.default.fileExists(atPath: installedRuntime.path))
        #expect(!FileManager.default.fileExists(atPath: fixture.controller.configURL.path))
        #expect(try String(contentsOf: blocker, encoding: .utf8) == "preserve this existing file")
        try FileManager.default.removeItem(at: blocker)
        await fixture.controller.initialize()
        #expect(fixture.controller.errorMessage == nil)
        #expect(fixture.controller.initialized)
        #expect(FileManager.default.fileExists(atPath: installedRuntime.appendingPathComponent("server/managed.mjs").path))
        #expect(!FileManager.default.fileExists(atPath: installedRuntime.appendingPathComponent(".glossa-install-owner").path))
    }

    @MainActor @Test func restoreStopsOnlyOwnedJobAndResumesOriginalRunningStateOnFailure() async throws {
        let fixture = try ServerControllerFixture()
        defer { fixture.remove() }
        await fixture.controller.initialize()
        await fixture.controller.start()
        #expect(fixture.controller.isRunning)
        await fixture.controller.createBackup()
        #expect(fixture.controller.backups.first?.verified == true)
        await fixture.runner.setRestoreFailure(true)
        await fixture.controller.restoreBackup(id: "snapshot-test")
        #expect(fixture.controller.errorMessage != nil)
        #expect(fixture.controller.isRunning)
        let history = await fixture.runner.history()
        let stop = try XCTUnwrap(history.firstIndex(of: "launchctl:bootout"))
        let restore = try XCTUnwrap(history.firstIndex(of: "cli:restore"))
        let restart = try XCTUnwrap(history.lastIndex(of: "launchctl:bootstrap"))
        #expect(stop < restore && restore < restart)
        await fixture.runner.setForeignJob()
        await fixture.controller.stop()
        #expect(fixture.controller.errorMessage?.contains("其他配置") == true)
        let nextHistory = await fixture.runner.history()
        #expect(nextHistory.filter { $0 == "launchctl:bootout" }.count == 1)
    }

    @MainActor @Test func runningConfigurationNeedsExplicitRestartAndProxySecretsStayLocal() async throws {
        let fixture = try ServerControllerFixture()
        defer { fixture.remove() }
        await fixture.controller.initialize()
        await fixture.controller.start()
        let invalid = LocalServerAISettings(enabled: true, endpoint: "https://provider.invalid/v1", model: "model", apiKey: "key\rvalue")
        await fixture.controller.saveSettings(port: 18788, backupIntervalHours: 12, retentionCount: 7, ai: invalid, restart: true)
        #expect(fixture.controller.errorMessage != nil)
        #expect(try fixture.configuration().port == 8787)
        let untouched = await fixture.runner.history()
        #expect(!untouched.contains("launchctl:bootout"))
        let provider = LocalServerAISettings(enabled: true, endpoint: "https://provider.invalid/v1/chat/completions", model: "owner-model", apiKey: "provider-secret-that-is-not-a-sync-token")
        await fixture.controller.saveSettings(port: 18788, backupIntervalHours: 12, retentionCount: 7, ai: provider)
        #expect(fixture.controller.errorMessage != nil)
        #expect(try fixture.configuration().port == 8787)
        await fixture.controller.saveSettings(port: 18788, backupIntervalHours: 12, retentionCount: 7, ai: provider, restart: true)
        #expect(fixture.controller.errorMessage == nil)
        #expect(fixture.controller.isRunning)
        let config = try fixture.configuration()
        let connection = try fixture.controller.syncConfiguration(projectID: "study")
        #expect(connection.url == "http://127.0.0.1:18788")
        #expect(connection.token == config.token)
        #expect(connection.token != provider.apiKey)
        let copied = try fixture.controller.connectionInformation(includeToken: true)
        #expect(copied.contains(config.token))
        #expect(!copied.contains(config.adminToken))
        #expect(!copied.contains(provider.apiKey))
    }
}

@MainActor private struct ServerControllerFixture {
    let directory: URL
    let runner: ManagedRunnerFixture
    let controller: LocalServerController
    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("glossa-managed-controller-\(UUID().uuidString)")
        let runtime = directory.appendingPathComponent("bundled-runtime")
        try FileManager.default.createDirectory(at: runtime.appendingPathComponent("server"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: runtime.appendingPathComponent("web"), withIntermediateDirectories: true)
        try Data("test runtime".utf8).write(to: runtime.appendingPathComponent("node"))
        try Data("// managed fixture".utf8).write(to: runtime.appendingPathComponent("server/managed.mjs"))
        runner = ManagedRunnerFixture()
        let callback = runner
        controller = LocalServerController(homeDirectory: directory.appendingPathComponent("home"), bundledRuntimeURL: runtime,
            runner: { executable, arguments in try await callback.run(executable, arguments) })
    }
    func configuration() throws -> LocalServerConfiguration {
        try JSONDecoder().decode(LocalServerConfiguration.self, from: Data(contentsOf: controller.configURL))
    }
    func remove() { try? FileManager.default.removeItem(at: directory) }
}

/// launchctl is replaced only in these tests. Files, configuration commits and
/// identity checks remain real, while no test registers a user's LaunchAgent.
private actor ManagedRunnerFixture {
    private var running = false
    private var job: String?
    private var events: [String] = []
    private var hasBackup = false
    private var restoreFailure = false
    func history() -> [String] { events }
    func setRestoreFailure(_ value: Bool) { restoreFailure = value }
    func setForeignJob() { job = "program = /foreign/node\n--config /foreign/config.json" }
    func run(_ executable: URL, _ arguments: [String]) async throws -> LocalProcessResult {
        if executable.lastPathComponent == "launchctl" {
            let command = arguments.first ?? ""
            events.append("launchctl:" + command)
            switch command {
            case "print": return LocalProcessResult(status: job == nil ? 113 : 0, output: job ?? "")
            case "bootstrap":
                let data = try Data(contentsOf: URL(fileURLWithPath: arguments[2]))
                let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: Any]
                job = (plist["ProgramArguments"] as! [String]).joined(separator: "\n")
                running = true
            case "kickstart": running = true
            case "bootout": job = nil; running = false
            default: break
            }
            return LocalProcessResult(status: 0)
        }
        let command = arguments[1]
        events.append("cli:" + command)
        let config = try JSONDecoder().decode(LocalServerConfiguration.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[3])))
        let backup: [String: Any] = ["id": "snapshot-test", "createdAt": "2026-10-23T12:00:00Z", "bytes": 4096,
                                   "sha256": String(repeating: "a", count: 64), "verified": true]
        var reply: [String: Any] = ["ok": true]
        switch command {
        case "status": reply.merge(["running": running, "instanceId": config.instanceId, "url": config.url,
            "ai": ["enabled": config.ai.enabled, "configured": config.ai.enabled && !config.ai.apiKey.isEmpty]]) { _, new in new }
        case "projects": reply["projects"] = [["id": "study", "mode": "e2ee", "operations": 3]]
        case "list-backups": reply["backups"] = hasBackup ? [backup] : []
        case "backup": hasBackup = true; reply["backup"] = backup
        case "verify-backup": reply["backup"] = backup
        case "restore":
            if running || restoreFailure { return LocalProcessResult(status: 1, output: "{\"ok\":false,\"error\":{\"code\":\"RESTORE_FAILED\",\"message\":\"备份校验失败，当前数据库已保留\"}}") }
            reply["restored"] = ["id": "snapshot-test", "safetyBackupId": "safety-test", "at": "2026-10-23T12:00:00Z"]
        default: break
        }
        let bytes = try JSONSerialization.data(withJSONObject: reply)
        return LocalProcessResult(status: 0, output: String(decoding: bytes, as: UTF8.self))
    }
}
