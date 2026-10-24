import Foundation
import Combine
import Security
import Darwin

public struct LocalProcessResult: Sendable {
    public let status: Int32
    public let output: String
    public let error: String
    public init(status: Int32, output: String = "", error: String = "") {
        self.status = status; self.output = output; self.error = error
    }
}

public struct LocalServerAISettings: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var endpoint: String
    public var model: String
    public var apiKey: String
    public init(enabled: Bool = false, endpoint: String = "", model: String = "", apiKey: String = "") {
        self.enabled = enabled; self.endpoint = endpoint; self.model = model; self.apiKey = apiKey
    }
}

public struct LocalServerConfiguration: Codable, Sendable {
    public var version = 1
    public var instanceId: String
    public var host = "127.0.0.1"
    public var port: Int
    public var token: String
    public var adminToken: String
    public var dataDir: String
    public var staticDir: String
    public var backupDir: String
    public var allowedOrigins: [String] = ["https://appassets.quietpaper.local"]
    public var backupIntervalHours = 24
    public var retentionCount = 14
    public var ai = LocalServerAISettings()
    public var url: String { "http://127.0.0.1:\(port)" }
}

public struct LocalServerProject: Identifiable, Sendable {
    public let id: String
    public let mode: String
    public let operations: Int
    public let lastReceivedAt: String?
}
public struct LocalServerBackup: Identifiable, Sendable {
    public let id: String
    public let createdAt: String
    public let bytes: Int
    public let sha256: String
    public let verified: Bool
    public let error: String?
}
public struct LocalAIProxyConnection: Sendable {
    public let url: String
    public let token: String
    public let instanceID: String
    public let enabled: Bool
    public let configured: Bool
}

/// Owns only the launchd job and data directory created for this managed instance.
/// No shell, port-based killing, repository working directory, or App lifetime coupling.
@MainActor public final class LocalServerController: ObservableObject {
    public typealias Runner = @Sendable (URL, [String]) async throws -> LocalProcessResult
    @Published public private(set) var initialized = false
    @Published public private(set) var isRunning = false
    @Published public private(set) var busy = false
    @Published public private(set) var statusMessage = "尚未初始化本机服务器"
    @Published public var errorMessage: String?
    @Published public private(set) var loginEnabled = false
    @Published public private(set) var projects: [LocalServerProject] = []
    @Published public private(set) var backups: [LocalServerBackup] = []
    @Published public private(set) var port = 8787
    @Published public private(set) var backupIntervalHours = 24
    @Published public private(set) var retentionCount = 14
    @Published public private(set) var aiSettings = LocalServerAISettings()
    @Published public private(set) var aiConfigured = false
    @Published public private(set) var pid: Int?
    @Published public private(set) var lastBackupAt: String?
    @Published public private(set) var nextBackupAt: String?
    @Published public private(set) var backupError: String?
    @Published public private(set) var lastVerification: String?
    public let rootDirectory: URL
    public let dataDirectory: URL
    public let logDirectory: URL
    public let configURL: URL
    public let loginAgentURL: URL
    public let servicePlistURL: URL
    private let runtimeDirectory: URL
    private let bundledRuntime: URL
    private let launchctl: URL
    private let runner: Runner
    private let domain: String
    private let label = "local.glossa.sync"
    private var configuration: LocalServerConfiguration?

    public init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
                bundledRuntimeURL: URL? = nil,
                launchctlPath: URL = URL(fileURLWithPath: "/bin/launchctl"),
                userID: UInt32 = getuid(), runner: @escaping Runner = { executable, arguments in try await LocalServerController.runProcess(executable, arguments) }) {
        rootDirectory = homeDirectory.appendingPathComponent("Library/Application Support/GlossaServer", isDirectory: true)
        dataDirectory = rootDirectory.appendingPathComponent("data", isDirectory: true)
        logDirectory = rootDirectory.appendingPathComponent("logs", isDirectory: true)
        runtimeDirectory = rootDirectory.appendingPathComponent("runtime", isDirectory: true)
        configURL = rootDirectory.appendingPathComponent("server-config.json")
        servicePlistURL = rootDirectory.appendingPathComponent("service.plist")
        loginAgentURL = homeDirectory.appendingPathComponent("Library/LaunchAgents/local.glossa.sync.plist")
        bundledRuntime = bundledRuntimeURL ?? (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("server-runtime", isDirectory: true)
        launchctl = launchctlPath; self.runner = runner; domain = "gui/\(userID)"
    }

    public var localURL: String { configuration?.url ?? "http://127.0.0.1:\(port)" }

    public func initialize(port: Int = 8787) async {
        await operation("正在初始化独立服务器…") {
            guard (1024...65535).contains(port) else { throw Self.failure("请选择 1024–65535 之间的端口") }
            let installed = try await Task.detached(priority: .userInitiated) { [rootDirectory, runtimeDirectory, bundledRuntime, configURL, dataDirectory, logDirectory] in
                let fm = FileManager.default
                guard !fm.fileExists(atPath: configURL.path) else { throw Self.failure("此目录已经初始化；请刷新已有服务，不会覆盖其数据。") }
                if fm.fileExists(atPath: dataDirectory.path), !(try fm.contentsOfDirectory(atPath: dataDirectory.path)).isEmpty {
                    throw Self.failure("目标数据目录已有内容。初始化已停止，原数据没有改动。")
                }
                guard fm.fileExists(atPath: bundledRuntime.appendingPathComponent("node").path),
                      fm.fileExists(atPath: bundledRuntime.appendingPathComponent("server/managed.mjs").path) else {
                    throw Self.failure("应用缺少内置服务器运行时，请使用完整 macOS 安装包。")
                }
                try fm.createDirectory(at: rootDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                guard !fm.fileExists(atPath: runtimeDirectory.path) else { throw Self.failure("服务器运行时目录已存在，未覆盖；请检查此前初始化记录。") }
                let staged = rootDirectory.appendingPathComponent("runtime-staging-\(UUID().uuidString)")
                let owner = UUID().uuidString
                let markerName = ".glossa-install-owner"
                var installedByThisAttempt = false
                do {
                    try fm.copyItem(at: bundledRuntime, to: staged)
                    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: staged.appendingPathComponent("node").path)
                    try Data(owner.utf8).write(to: staged.appendingPathComponent(markerName), options: .atomic)
                    try fm.moveItem(at: staged, to: runtimeDirectory)
                    installedByThisAttempt = true
                    for directory in [dataDirectory, logDirectory, rootDirectory.appendingPathComponent("backups")] {
                        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    }
                    let config = LocalServerConfiguration(instanceId: UUID().uuidString.lowercased(), port: port,
                        token: try Self.randomToken(), adminToken: try Self.randomToken(), dataDir: dataDirectory.path,
                        staticDir: runtimeDirectory.appendingPathComponent("web").path,
                        backupDir: rootDirectory.appendingPathComponent("backups").path)
                    try Self.writeConfiguration(config, at: configURL)
                    try? fm.removeItem(at: runtimeDirectory.appendingPathComponent(markerName))
                    return config
                } catch {
                    try? fm.removeItem(at: staged)
                    // A config that reached atomic rename may already refer to this
                    // runtime even if later fsync failed. Keep both for inspection.
                    // Otherwise delete only this attempt's provably owned install,
                    // leaving existing directories and other attempts untouched.
                    let marker = runtimeDirectory.appendingPathComponent(markerName)
                    if installedByThisAttempt, !fm.fileExists(atPath: configURL.path),
                       (try? String(contentsOf: marker, encoding: .utf8)) == owner {
                        try fm.removeItem(at: runtimeDirectory)
                    }
                    throw error
                }
            }.value
            configuration = installed
            try await writeServicePlist(installed)
            try await refreshInternal()
        }
    }

    public func refresh(silent: Bool = false) async {
        if silent {
            guard !busy else { return }
            do { try await refreshInternal() }
            catch { statusMessage = "状态暂不可用：\(error.localizedDescription)" }
        } else { await operation("正在读取真实服务状态…") { try await refreshInternal() } }
    }
    public func start() async { await operation("正在启动独立后台服务…") { try await startInternal(); try await refreshInternal() } }
    public func stop() async { await operation("正在停止本实例服务…") { try await stopInternal(); try await refreshInternal() } }

    public func createBackup() async {
        await operation("正在生成一致性备份…") {
            let response = try await cli("backup")
            if let value = response["backup"] as? [String: Any] { lastVerification = "已备份并校验：\(value["id"] as? String ?? "")" }
            try await refreshInternal()
        }
    }
    public func verifyBackup(id: String) async {
        await operation("正在校验备份…") {
            let response = try await cli("verify-backup", id: id)
            guard let backup = response["backup"] as? [String: Any], backup["verified"] as? Bool == true else { throw Self.failure("备份未通过完整性校验") }
            lastVerification = "完整性校验通过：\(id)"
            try await refreshInternal()
        }
    }

    /// The UI must obtain explicit confirmation before invoking this method.
    public func restoreBackup(id: String) async {
        await operation("正在保留当前资料并恢复备份…") {
            try await refreshInternal()
            let wasRunning = isRunning
            if wasRunning { try await stopInternal() }
            var restoreError: Error?
            do {
                _ = try await cli("restore", id: id)
                lastVerification = "已恢复 \(id)；恢复前数据库另存为安全备份。"
            } catch { restoreError = error }
            if wasRunning {
                do { try await startInternal() }
                catch { throw Self.failure("\(restoreError?.localizedDescription ?? "备份恢复已完成")；服务未重新启动：\(error.localizedDescription)") }
            }
            try await refreshInternal()
            if let restoreError { throw restoreError }
        }
    }

    public func saveSettings(port: Int, backupIntervalHours: Int, retentionCount: Int,
                             ai: LocalServerAISettings, restart: Bool = false) async {
        await operation(restart ? "正在保存配置并重启服务…" : "正在保存服务器配置…") {
            guard configuration != nil else { throw Self.failure("请先初始化本机服务器") }
            guard (1024...65535).contains(port), (1...720).contains(backupIntervalHours), (1...365).contains(retentionCount) else { throw Self.failure("端口或备份参数超出有效范围") }
            if ai.enabled {
                guard let url = URLComponents(string: ai.endpoint), let host = url.host?.lowercased(),
                      (url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host))),
                      url.user == nil, url.password == nil, url.fragment == nil, url.query == nil,
                      url.path.hasSuffix("/chat/completions"),
                      !ai.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, ai.model.utf16.count <= 200,
                      !ai.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      ai.apiKey.rangeOfCharacter(from: CharacterSet(charactersIn: "\r\n\0")) == nil else { throw Self.failure("启用 AI 代理需要有效的 HTTPS 地址、模型和 API 密钥；本机服务允许回环 HTTP。") }
            }
            try await refreshInternal()
            guard var config = configuration else { throw Self.failure("服务器配置已不存在，未保存修改。") }
            let wasRunning = isRunning
            guard !wasRunning || restart else { throw Self.failure("运行中的服务器需要明确重启才能应用新配置") }
            let original = config
            if wasRunning { try await stopInternal() }
            config.port = port; config.backupIntervalHours = backupIntervalHours
            config.retentionCount = retentionCount; config.ai = ai
            do {
                let next = config
                try await Task.detached { [configURL] in try Self.writeConfiguration(next, at: configURL) }.value
                configuration = config
                try await writeServicePlist(config)
                if loginEnabled { try await writeLoginPlist() }
                if wasRunning { try await startInternal() }
            } catch {
                let reason = error.localizedDescription
                configuration = original
                do {
                    try await Task.detached { [configURL] in try Self.writeConfiguration(original, at: configURL) }.value
                    try await writeServicePlist(original)
                    if loginEnabled { try await writeLoginPlist() }
                    if wasRunning { try await startInternal() }
                    try? await refreshInternal()
                } catch { throw Self.failure("新配置未能应用（\(reason)）；恢复此前服务时失败：\(error.localizedDescription)") }
                throw Self.failure("新配置未能应用，已恢复此前配置：\(reason)")
            }
            try await refreshInternal()
        }
    }

    public func setLoginEnabled(_ enabled: Bool) async {
        await operation(enabled ? "正在启用登录启动…" : "正在关闭登录启动…") {
            guard configuration != nil else { throw Self.failure("请先初始化本机服务器") }
            if enabled { try await writeLoginPlist() }
            else {
                let target = loginAgentURL, configPath = configURL.path
                try await Task.detached {
                    if FileManager.default.fileExists(atPath: target.path) {
                        let data = try Data(contentsOf: target)
                        guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                              plist["Label"] as? String == "local.glossa.sync",
                              (plist["ProgramArguments"] as? [String])?.contains(configPath) == true else { throw Self.failure("登录启动文件不属于此服务，未删除。") }
                        try FileManager.default.removeItem(at: target)
                    }
                }.value
            }
            try await refreshInternal()
        }
    }

    public func syncConfiguration(projectID: String, mode: String = "plain") throws -> SyncConfiguration {
        guard let configuration else { throw Self.failure("请先初始化本机服务器") }
        return SyncConfiguration(url: configuration.url, token: configuration.token, projectID: projectID, mode: mode)
    }
    public func proxyConnection() throws -> LocalAIProxyConnection {
        guard let configuration else { throw Self.failure("请先初始化本机服务器") }
        return LocalAIProxyConnection(url: configuration.url, token: configuration.token, instanceID: configuration.instanceId,
                                      enabled: configuration.ai.enabled, configured: aiConfigured)
    }
    public func connectionInformation(includeToken: Bool = false) throws -> String {
        guard let configuration else { throw Self.failure("请先初始化本机服务器") }
        return "笺注本机同步\n地址：\(configuration.url)\n" + (includeToken ? "访问令牌：\(configuration.token)\n" : "") +
            "工程标识请从需要同步的笔记工程复制。\n跨设备连接请配置 HTTPS 入口；127.0.0.1 仅指当前设备。"
    }

    private func operation(_ message: String, _ body: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; errorMessage = nil; statusMessage = message
        defer { busy = false }
        do { try await body() }
        catch { errorMessage = error.localizedDescription; statusMessage = "操作未完成；原有数据已保留" }
    }

    private func refreshInternal() async throws {
        let loaded = try await Task.detached { [configURL, loginAgentURL] () -> (LocalServerConfiguration?, Bool) in
            guard FileManager.default.fileExists(atPath: configURL.path) else { return (nil, false) }
            return (try JSONDecoder().decode(LocalServerConfiguration.self, from: Data(contentsOf: configURL)),
                    FileManager.default.fileExists(atPath: loginAgentURL.path))
        }.value
        configuration = loaded.0; initialized = loaded.0 != nil; loginEnabled = loaded.1
        guard let config = configuration else { isRunning = false; statusMessage = "尚未初始化本机服务器"; return }
        port = config.port; backupIntervalHours = config.backupIntervalHours; retentionCount = config.retentionCount; aiSettings = config.ai
        let state = try await cli("status")
        guard state["instanceId"] as? String == config.instanceId else { throw Self.failure("此端口响应的服务身份与本实例不同；未操作其他进程。") }
        isRunning = state["running"] as? Bool == true
        pid = state["pid"] as? Int
        if let schedule = state["backup"] as? [String: Any] {
            lastBackupAt = Self.string(schedule["lastAt"]); nextBackupAt = Self.string(schedule["nextAt"])
            backupError = Self.string(schedule["lastError"])
        } else { nextBackupAt = nil }
        aiConfigured = (state["ai"] as? [String: Any])?["configured"] as? Bool ?? (config.ai.enabled && !config.ai.apiKey.isEmpty && !config.ai.endpoint.isEmpty && !config.ai.model.isEmpty)
        let projectReply = try await cli("projects")
        projects = (projectReply["projects"] as? [[String: Any]] ?? []).compactMap { value in
            guard let id = value["id"] as? String else { return nil }
            return LocalServerProject(id: id, mode: value["mode"] as? String ?? "plain",
                operations: value["operations"] as? Int ?? 0, lastReceivedAt: Self.string(value["lastReceivedAt"]))
        }
        let backupReply = try await cli("list-backups")
        backups = (backupReply["backups"] as? [[String: Any]] ?? []).compactMap { value in
            guard let id = value["id"] as? String else { return nil }
            return LocalServerBackup(id: id, createdAt: Self.string(value["createdAt"]) ?? id,
                bytes: value["bytes"] as? Int ?? 0, sha256: value["sha256"] as? String ?? "",
                verified: value["verified"] as? Bool ?? false, error: Self.string(value["error"]))
        }
        if lastBackupAt == nil { lastBackupAt = backups.first?.createdAt }
        statusMessage = isRunning ? "服务器正在运行\(pid.map { " · PID \($0)" } ?? "")" : "服务器已停止 · 数据保留在此 Mac"
    }

    private func startInternal() async throws {
        guard let config = configuration else { throw Self.failure("请先初始化本机服务器") }
        let status = try await cli("status")
        if status["running"] as? Bool == true {
            guard status["instanceId"] as? String == config.instanceId else { throw Self.failure("端口已由其他服务占用，未操作该进程。") }
            isRunning = true; return
        }
        guard status["locked"] as? Bool != true else { throw Self.failure("数据库仍由另一个进程使用，未注册或停止任何任务。请稍后刷新。") }
        try await writeServicePlist(config)
        let job = try await runner(launchctl, ["print", "\(domain)/\(label)"])
        if job.status == 0 {
            try validateJobOwnership(job.output)
            let kick = try await runner(launchctl, ["kickstart", "\(domain)/\(label)"])
            guard kick.status == 0 else { throw Self.failure("launchd 未能启动此服务，请查看服务器日志。") }
        } else {
            let bootstrap = try await runner(launchctl, ["bootstrap", domain, servicePlistURL.path])
            guard bootstrap.status == 0 else { throw Self.failure("launchd 未能注册此服务（\(bootstrap.status)）；没有停止其他进程。") }
        }
        for _ in 0..<30 {
            if let ready = try? await cli("status"), ready["running"] as? Bool == true,
               ready["instanceId"] as? String == config.instanceId { isRunning = true; return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        let current = try await runner(launchctl, ["print", "\(domain)/\(label)"])
        if current.status == 0, (try? validateJobOwnership(current.output)) != nil {
            _ = try await runner(launchctl, ["bootout", "\(domain)/\(label)"])
        }
        throw Self.failure("服务器未就绪，请查看日志并检查端口 \(config.port) 是否已被使用；未停止占用端口的其他进程。")
    }

    private func stopInternal() async throws {
        let job = try await runner(launchctl, ["print", "\(domain)/\(label)"])
        if job.status != 0 {
            let state = try await cli("status")
            guard state["running"] as? Bool != true, state["locked"] as? Bool != true else { throw Self.failure("此服务器并非由本面板的 launchd 任务启动，请使用原启动方式停止。") }
            isRunning = false; return
        }
        try validateJobOwnership(job.output)
        let result = try await runner(launchctl, ["bootout", "\(domain)/\(label)"])
        guard result.status == 0 else { throw Self.failure("launchd 未能停止本实例服务；没有执行备份恢复。") }
        for _ in 0..<60 {
            if let state = try? await cli("status"), state["running"] as? Bool != true, state["locked"] as? Bool != true { isRunning = false; return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw Self.failure("服务器仍在退出，未继续恢复或修改配置。请稍后刷新状态。")
    }

    private func validateJobOwnership(_ output: String) throws {
        guard output.contains(runtimeDirectory.appendingPathComponent("node").path), output.contains(configURL.path) else {
            throw Self.failure("同名 launchd 任务属于其他配置，未停止或替换它。")
        }
    }
    private func cli(_ command: String, id: String? = nil) async throws -> [String: Any] {
        var args = [runtimeDirectory.appendingPathComponent("server/managed.mjs").path, command, "--config", configURL.path]
        if let id { args += ["--id", id] }
        let result = try await runner(runtimeDirectory.appendingPathComponent("node"), args)
        guard let data = result.output.data(using: .utf8),
              let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Self.failure("服务器管理命令未返回有效状态（\(result.status)）；请检查完整运行时。")
        }
        if result.status != 0 || reply["ok"] as? Bool != true {
            let detail = reply["error"] as? [String: Any]
            throw Self.failure(detail?["message"] as? String ?? "服务器管理操作失败；原数据保留。")
        }
        return reply
    }
    private func writeServicePlist(_ config: LocalServerConfiguration) async throws {
        let plist: [String: Any] = ["Label": label,
            "ProgramArguments": [runtimeDirectory.appendingPathComponent("node").path, runtimeDirectory.appendingPathComponent("server/managed.mjs").path, "serve", "--config", configURL.path],
            "WorkingDirectory": rootDirectory.path, "RunAtLoad": true, "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 10, "ProcessType": "Background", "Umask": 0o077,
            "StandardOutPath": logDirectory.appendingPathComponent("server.log").path,
            "StandardErrorPath": logDirectory.appendingPathComponent("server-error.log").path,
            "EnvironmentVariables": ["NODE_NO_WARNINGS": "1"]]
        let bytes = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try await Task.detached { [servicePlistURL] in
            try bytes.write(to: servicePlistURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: servicePlistURL.path)
        }.value
    }
    private func writeLoginPlist() async throws {
        let source = servicePlistURL, target = loginAgentURL, configPath = configURL.path
        try await Task.detached {
            let fm = FileManager.default
            if fm.fileExists(atPath: target.path) {
                let previous = try Data(contentsOf: target)
                guard let plist = try PropertyListSerialization.propertyList(from: previous, format: nil) as? [String: Any],
                      (plist["ProgramArguments"] as? [String])?.contains(configPath) == true else { throw Self.failure("登录启动文件属于其他实例，未覆盖。") }
            }
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(contentsOf: source).write(to: target, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        }.value
    }
    private nonisolated static func writeConfiguration(_ config: LocalServerConfiguration, at url: URL) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(config).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let file = try FileHandle(forWritingTo: url); defer { try? file.close() }; try file.synchronize()
        let fd = open(url.deletingLastPathComponent().path, O_RDONLY)
        guard fd >= 0 else { throw failure("无法确认配置目录写入") }; defer { close(fd) }
        guard fsync(fd) == 0 else { throw failure("服务器配置写入未获确认") }
    }
    private nonisolated static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw failure("无法生成安全访问令牌") }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    private nonisolated static func string(_ value: Any?) -> String? {
        if let string = value as? String { return string }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }
    private nonisolated static func failure(_ message: String) -> NSError {
        NSError(domain: "Glossa.LocalServer", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// Process pipes are drained concurrently off the main actor; only our child
    /// command is terminated on timeout, never a PID inferred from a network port.
    public nonisolated static func runProcess(_ executable: URL, _ arguments: [String]) async throws -> LocalProcessResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process(), stdout = Pipe(), stderr = Pipe()
                process.executableURL = executable; process.arguments = arguments
                process.standardOutput = stdout; process.standardError = stderr
                var environment = ProcessInfo.processInfo.environment; environment["NODE_NO_WARNINGS"] = "1"
                process.environment = environment
                do {
                    try process.run()
                    let group = DispatchGroup()
                    let errorLock = NSLock()
                    var errorBytes = Data()
                    group.enter()
                    DispatchQueue.global(qos: .utility).async {
                        let data = stderr.fileHandleForReading.readDataToEndOfFile()
                        errorLock.lock(); errorBytes = data; errorLock.unlock(); group.leave()
                    }
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 180) { if process.isRunning { process.terminate() } }
                    let output = stdout.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit(); group.wait()
                    errorLock.lock(); let errors = errorBytes; errorLock.unlock()
                    continuation.resume(returning: LocalProcessResult(status: process.terminationStatus,
                        output: String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                        error: String(decoding: errors, as: UTF8.self)))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
}
