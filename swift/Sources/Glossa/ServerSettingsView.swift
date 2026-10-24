import SwiftUI
import AppKit
import GlossaCore

@MainActor struct ServerSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var server: LocalServerController
    private let projectID: String
    private let onConnect: ((SyncConfiguration) -> Void)?
    @State private var tab = "overview"
    @State private var draftPort = 8787
    @State private var draftInterval = 24
    @State private var draftRetention = 14
    @State private var providerEnabled = false
    @State private var providerEndpoint = ""
    @State private var providerModel = ""
    @State private var providerKey = ""
    @State private var providerExpanded = false
    @State private var restoreID: String?
    @State private var confirmRestart = false
    @State private var copied = false

    init(projectID: String = "", onConnect: ((SyncConfiguration) -> Void)? = nil,
         controller: LocalServerController? = nil) {
        self.projectID = projectID; self.onConnect = onConnect
        let arguments = CommandLine.arguments
        let isolatedHome: URL? = arguments.firstIndex(of: "--server-home").flatMap { index in
            arguments.indices.contains(index + 1) ? URL(fileURLWithPath: arguments[index + 1], isDirectory: true) : nil
        }
        _server = StateObject(wrappedValue: controller ?? LocalServerController(homeDirectory: isolatedHome ?? FileManager.default.homeDirectoryForCurrentUser))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            if server.initialized {
                Picker("服务器管理", selection: $tab) {
                    Text("服务与工程").tag("overview")
                    Text("备份与恢复").tag("backups")
                    Text("服务器配置").tag("settings")
                }.pickerStyle(.segmented)
                Group {
                    if tab == "backups" { backupPanel }
                    else if tab == "settings" { configurationPanel }
                    else { overviewPanel }
                }.disabled(server.busy)
            } else { setupPanel.disabled(server.busy) }
            Divider().overlay(Palette.line)
            HStack(spacing: 10) {
                if server.busy { ProgressView().controlSize(.small) }
                Text(server.statusMessage).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(2)
                Spacer()
                Button("刷新") { Task { await server.refresh() } }.disabled(server.busy)
                Button("完成") { dismiss() }.keyboardShortcut(.cancelAction).disabled(server.busy)
            }
        }.padding(28).frame(width: 820, height: 720).background(Palette.paper)
            .interactiveDismissDisabled(server.busy)
            .task {
                await server.refresh(); loadDraft()
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                    if !server.busy { await server.refresh(silent: true) }
                }
            }
            .alert("服务器操作未完成", isPresented: Binding(get: { server.errorMessage != nil }, set: { if !$0 { server.errorMessage = nil } })) {
                Button("知道了") { server.errorMessage = nil }
            } message: { Text(server.errorMessage ?? "") }
            .confirmationDialog("恢复这份服务器备份？", isPresented: Binding(get: { restoreID != nil }, set: { if !$0 { restoreID = nil } })) {
                Button("保留当前安全备份并恢复", role: .destructive) {
                    if let id = restoreID { Task { await server.restoreBackup(id: id) } }
                    restoreID = nil
                }
                Button("取消", role: .cancel) { restoreID = nil }
            } message: {
                Text("恢复会暂时停止本实例服务、保存当前数据库的安全备份，再验证并恢复所选版本。原先运行的服务会随后重新启动；客户端保留的较新操作会在下次同步补回。")
            }
            .confirmationDialog("保存新配置并重启服务？", isPresented: $confirmRestart) {
                Button("保存并重启服务") { saveSettings(restart: true) }
                Button("继续编辑", role: .cancel) {}
            } message: { Text("当前连接会短暂中断，客户端本地修改会保留并在服务恢复后继续同步。") }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 15) {
            Image(systemName: "externaldrive.connected.to.line.below").font(.system(size: 30, weight: .ultraLight)).foregroundStyle(Palette.plum).padding(.top, 7)
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "YOUR MAC, YOUR ARCHIVE")
                Text("本机服务器").font(.custom("Songti SC", size: 30))
                Text("独立保存与同步。关闭笺注窗口，服务仍可继续运行。")
                    .font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
            Spacer()
            if server.initialized {
                Label(server.isRunning ? "运行中" : "已停止", systemImage: server.isRunning ? "circle.fill" : "circle")
                    .font(.system(size: 11)).foregroundStyle(server.isRunning ? Palette.green : Palette.muted)
                    .padding(.horizontal, 12).padding(.vertical, 7).background(Palette.background).clipShape(Capsule())
            }
        }
    }

    private var setupPanel: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer()
            Text("让这台 Mac 成为自己的资料库").font(.custom("Songti SC", size: 25))
            Text("初始化会在下面的新目录中安装内置运行时，并创建独立数据库、随机访问令牌和备份目录。不会读取或覆盖工程仓库中的 server-data，也不需要终端命令。")
                .font(.system(size: 13)).lineSpacing(7).foregroundStyle(Palette.muted)
            pathRow("服务器目录", server.rootDirectory)
            HStack {
                Text("本机端口").font(.system(size: 12))
                TextField("8787", value: $draftPort, format: .number.grouping(.never)).textFieldStyle(.roundedBorder).frame(width: 110)
                Text("仅监听 127.0.0.1").font(.system(size: 11)).foregroundStyle(Palette.muted)
            }
            Text("跨设备访问可在之后配置 HTTPS 代理；此处的本机地址只在这台 Mac 上有效。")
                .font(.system(size: 11)).foregroundStyle(Palette.muted)
            Button("初始化新服务器") {
                Task { await server.initialize(port: draftPort); if server.initialized { loadDraft() } }
            }.buttonStyle(PrimaryButton()).accessibilityIdentifier("initialize-local-server")
            Spacer()
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(Palette.background.opacity(0.55)).clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var overviewPanel: some View {
        VStack(alignment: .leading, spacing: 19) {
            HStack {
                VStack(alignment: .leading, spacing: 7) {
                    Text(server.localURL).font(.system(size: 16, design: .monospaced)).textSelection(.enabled)
                    Text("本机回环地址 · 外部设备须使用你配置的 HTTPS 入口").font(.system(size: 10)).foregroundStyle(Palette.muted)
                }
                Spacer()
                if server.isRunning {
                    Button("停止服务") { Task { await server.stop() } }.buttonStyle(QuietButton()).accessibilityIdentifier("stop-local-server")
                } else {
                    Button("启动服务") { Task { await server.start() } }.buttonStyle(PrimaryButton()).accessibilityIdentifier("start-local-server")
                }
            }.padding(18).background(Palette.background.opacity(0.6)).clipShape(RoundedRectangle(cornerRadius: 5))
            HStack {
                Toggle("登录此 Mac 后启动服务", isOn: Binding(get: { server.loginEnabled }, set: { value in Task { await server.setLoginEnabled(value) } }))
                    .toggleStyle(.switch).controlSize(.small)
                Spacer()
                Button("复制连接信息") { copyConnection(includeToken: true) }
                Button("复制令牌") {
                    do { copy(try server.syncConfiguration(projectID: projectID).token) }
                    catch { server.errorMessage = error.localizedDescription }
                }
            }.font(.system(size: 11))
            HStack(spacing: 20) {
                Button("显示数据目录") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: server.dataDirectory.path) }
                Button("显示服务日志") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: server.logDirectory.path) }
                if server.isRunning { Button("打开本机阅读端") { if let url = URL(string: server.localURL) { NSWorkspace.shared.open(url) } } }
                if copied { Text("已复制").foregroundStyle(Palette.green) }
            }.font(.system(size: 11)).foregroundStyle(Palette.plum)
            Divider()
            HStack { Eyebrow(text: "已归档工程"); Spacer(); Text("\(server.projects.count) 个").font(.system(size: 11)).foregroundStyle(Palette.muted) }
            if server.projects.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "tray").font(.system(size: 29, weight: .ultraLight)).foregroundStyle(Palette.plum)
                    Text("工程会从第一次同步开始归档").font(.custom("Songti SC", size: 19))
                    Text("启动服务后，将已有工程的客户端连接到这里。 ").font(.system(size: 12)).foregroundStyle(Palette.muted)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(spacing: 11) {
                        ForEach(server.projects) { project in
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(project.id).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                                    Text("\(project.mode == "e2ee" ? "端到端加密" : "普通同步") · \(project.operations) 条操作" + (project.lastReceivedAt.map { " · " + $0 } ?? ""))
                                        .font(.system(size: 10)).foregroundStyle(Palette.muted)
                                }
                                Spacer()
                                Button("复制标识") { copy(project.id) }.font(.system(size: 10))
                            }.padding(14).background(Palette.background.opacity(0.6)).clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                }
            }
            if let onConnect, !projectID.isEmpty {
                HStack { Spacer(); Button("连接当前工程到本机") {
                    do { onConnect(try server.syncConfiguration(projectID: projectID)); dismiss() }
                    catch { server.errorMessage = error.localizedDescription }
                }.buttonStyle(PrimaryButton()).disabled(!server.isRunning).accessibilityIdentifier("connect-local-server") }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var backupPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("每 \(server.backupIntervalHours) 小时自动备份 · 保留 \(server.retentionCount) 份").font(.system(size: 12))
                    Text("上次：\(server.lastBackupAt ?? "尚无记录")\n下次：\(server.nextBackupAt ?? "服务启动后排期")").font(.system(size: 10)).lineSpacing(4).foregroundStyle(Palette.muted)
                }
                Spacer()
                Button("立即备份") { Task { await server.createBackup() } }.buttonStyle(PrimaryButton()).accessibilityIdentifier("backup-local-server")
            }
            if let warning = server.backupError { Text(warning).font(.system(size: 11)).foregroundStyle(.red) }
            if let result = server.lastVerification { Text(result).font(.system(size: 11)).foregroundStyle(Palette.green).lineLimit(2) }
            Divider()
            if server.backups.isEmpty {
                EmptyState(symbol: "externaldrive.badge.timemachine", title: "为资料留一份后路", message: "立即备份会生成 SQLite 一致性快照，并校验备份完整性。")
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        ForEach(server.backups) { backup in backupRow(backup) }
                    }
                }
            }
            Text("备份包含整个服务器归档。恢复前自动保留当前数据库；端到端加密内容仍需要原口令才能在客户端解锁。")
                .font(.system(size: 11)).foregroundStyle(Palette.muted).lineSpacing(5)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    private func backupRow(_ backup: LocalServerBackup) -> some View {
        HStack(alignment: .top, spacing: 15) {
            Image(systemName: backup.verified ? "checkmark.shield" : "exclamationmark.shield").foregroundStyle(backup.verified ? Palette.green : Palette.muted)
            VStack(alignment: .leading, spacing: 7) {
                Text(backup.id).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                Text(backup.createdAt + " · " + ByteCountFormatter.string(fromByteCount: Int64(backup.bytes), countStyle: .file)).font(.system(size: 10)).foregroundStyle(Palette.muted)
                if let error = backup.error { Text(error).font(.system(size: 10)).foregroundStyle(.red) }
            }
            Spacer()
            Button("校验") { Task { await server.verifyBackup(id: backup.id) } }
            Button("恢复…") { restoreID = backup.id }.disabled(!backup.verified)
        }.font(.system(size: 11)).padding(15).background(Palette.background.opacity(0.6)).clipShape(RoundedRectangle(cornerRadius: 5))
    }

    private var configurationPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Form {
                Section("本机服务") {
                    TextField("监听端口", value: $draftPort, format: .number.grouping(.never))
                    Text("服务固定监听 127.0.0.1；不会自行暴露到局域网或公网。")
                        .font(.system(size: 10)).foregroundStyle(Palette.muted)
                    Stepper("自动备份间隔：\(draftInterval) 小时", value: $draftInterval, in: 1...720)
                    Stepper("保留备份：\(draftRetention) 份", value: $draftRetention, in: 1...365)
                }
                Section {
                    DisclosureGroup("AI 代理配置", isExpanded: $providerExpanded) {
                        Toggle("启用本机 AI 代理", isOn: $providerEnabled)
                        TextField("完整接口地址", text: $providerEndpoint, prompt: Text("https://…/v1/chat/completions"))
                        TextField("模型名称", text: $providerModel)
                        SecureField("服务商 API 密钥", text: $providerKey)
                        Text("密钥只保存在此 Mac 的私有服务器配置中，不会发送给其他客户端。启用代理不会自动发送笔记；每个任务仍需明确授权内容与有效期。")
                            .font(.system(size: 10)).foregroundStyle(Palette.muted).lineSpacing(5)
                    }
                    Label(server.aiSettings.enabled ? (server.aiConfigured ? "代理已配置，可按任务授权" : "代理已启用，尚未完整配置") : "AI 代理未启用",
                          systemImage: server.aiConfigured ? "checkmark.circle" : "circle")
                        .font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
                Section("独立服务器目录") {
                    Text(server.rootDirectory.path).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                    Text("运行时已复制到稳定目录，应用移动或关闭不影响正在运行的服务。")
                        .font(.system(size: 10)).foregroundStyle(Palette.muted)
                }
            }.formStyle(.grouped)
            HStack {
                Text(server.isRunning ? "应用新配置需要重启服务。" : "保存后，下次启动服务时应用。 ")
                    .font(.system(size: 11)).foregroundStyle(Palette.muted)
                Spacer()
                Button("保存配置") { if server.isRunning { confirmRestart = true } else { saveSettings(restart: false) } }.buttonStyle(PrimaryButton())
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func saveSettings(restart: Bool) {
        let ai = LocalServerAISettings(enabled: providerEnabled, endpoint: providerEndpoint.trimmingCharacters(in: .whitespacesAndNewlines),
            model: providerModel.trimmingCharacters(in: .whitespacesAndNewlines), apiKey: providerKey)
        Task { await server.saveSettings(port: draftPort, backupIntervalHours: draftInterval, retentionCount: draftRetention, ai: ai, restart: restart); if server.errorMessage == nil { loadDraft() } }
    }
    private func loadDraft() {
        draftPort = server.port; draftInterval = server.backupIntervalHours; draftRetention = server.retentionCount
        providerEnabled = server.aiSettings.enabled; providerEndpoint = server.aiSettings.endpoint
        providerModel = server.aiSettings.model; providerKey = server.aiSettings.apiKey
    }
    private func pathRow(_ label: String, _ url: URL) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: label)
            Text(url.path).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).padding(13)
                .frame(maxWidth: .infinity, alignment: .leading).background(Palette.paper).clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }
    private func copyConnection(includeToken: Bool) {
        do { copy(try server.connectionInformation(includeToken: includeToken)) }
        catch { server.errorMessage = error.localizedDescription }
    }
    private func copy(_ value: String) {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string)
        copied = true
    }
}
