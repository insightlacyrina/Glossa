import SwiftUI
import AppKit
import GlossaCore

struct SettingsView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.dismiss) var dismiss
    @State private var showSources = false
    @State private var showServer = false
    @State private var pendingLocalConnection: SyncConfiguration?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Mac 同步").font(.custom("Songti SC", size: 29)).foregroundStyle(Palette.ink); Spacer(); Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.borderless).foregroundStyle(Palette.muted) }
            Text("连接你自己的 Mac 服务。客户端关闭后，独立服务仍可运行。")
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 12) {
                        sectionTitle("本机服务器")
                        Button { showServer = true } label: { Label("管理这台 Mac 上的服务器", systemImage: "server.rack") }
                            .buttonStyle(QuietButton()).foregroundStyle(Palette.plum)
                        Text("独立运行的服务：启停、自动备份、恢复和临时 AI 代理。关闭阅读窗口后仍可工作。")
                            .font(.system(size: 11)).foregroundStyle(Palette.muted)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        sectionTitle("连接")
                        syncRow("服务器地址") {
                            TextField("", text: $store.syncSettings.url, prompt: Text("https://your-mac.example"))
                                .accessibilityLabel("服务器地址")
                        }
                        syncRow("工程标识") {
                            TextField("", text: $store.syncSettings.projectID, prompt: Text(store.projectID))
                                .accessibilityLabel("工程标识")
                        }
                        syncRow("访问令牌") {
                            SecureField("", text: $store.token).accessibilityLabel("访问令牌")
                        }
                        syncRow("同步模式") {
                            Picker("同步模式", selection: $store.syncSettings.mode) {
                                Text("普通同步").tag("plain"); Text("端到端加密").tag("e2ee")
                            }
                            .labelsHidden().pickerStyle(.menu).buttonStyle(.borderless)
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(Palette.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.line))
                        }
                        if store.syncSettings.mode == "e2ee" {
                            syncRow("加密口令") {
                                SecureField("", text: $store.passphrase).accessibilityLabel("加密口令")
                            }
                            Text("口令只在本次运行中保留，重启后需重新解锁。已同步工程不能原位更改加密模式或口令。")
                                .font(.system(size: 11)).foregroundStyle(Palette.muted)
                        }
                        Toggle("自动同步（前台每 8 秒重试）", isOn: $store.syncSettings.enabled)
                            .toggleStyle(.switch).controlSize(.small)
                        Text("远端连接使用 HTTPS；本机回环允许 HTTP。令牌存入 macOS 钥匙串。")
                            .font(.system(size: 11)).foregroundStyle(Palette.muted)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        sectionTitle("此 Mac 的工作副本")
                        syncRow("当前工程") { Text(store.projectID).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }
                        syncRow("不可变操作") { Text("\(store.operationCount)") }
                        syncRow("本地资料库") {
                            Button("在 Finder 中显示") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: store.directory.path) }
                                .buttonStyle(.borderless).foregroundStyle(Palette.plum)
                        }
                        Button("查看工程内保存的原生源快照") { showSources = true }
                            .buttonStyle(.borderless).foregroundStyle(Palette.plum)
                        Text("Mac 端保留源快照与历史；动态源文件授权、写回和原稿结构修改在 Android 平板处理。")
                            .font(.system(size: 11)).foregroundStyle(Palette.muted)
                    }
                }
                .font(.system(size: 12))
                .foregroundStyle(Palette.ink)
                .tint(Palette.plum)
                .textFieldStyle(SyncFieldStyle())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
            }
            .scrollContentBackground(.hidden)
            HStack {
                Text(store.syncStatus).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(2)
                Spacer()
                Button("保存连接") { store.saveSyncSettings() }.buttonStyle(PrimaryButton())
                    .disabled(store.syncSettings.enabled && (store.syncSettings.url.isEmpty || store.token.isEmpty || (store.syncSettings.mode == "e2ee" && store.passphrase.count < 12)))
            }
        }.padding(28).frame(width: 650, height: 720).background(Palette.paper)
            .onAppear {
                store.resetSyncDraft()
                if store.syncSettings.projectID.isEmpty { store.syncSettings.projectID = store.projectID }
            }
            .sheet(isPresented: $showSources) {
                VStack(alignment: .leading, spacing: 18) {
                    HStack { Text("原生源快照").font(.custom("Songti SC", size: 25)); Spacer(); Button("完成") { showSources = false } }
                    Text("保留工程中的完整源数据，下面是只读视图。完整恢复请导出 .glossa 工程。 ").font(.system(size: 11)).foregroundStyle(Palette.muted)
                    ScrollView([.horizontal, .vertical]) { Text(store.snapshot?.nativeSourcesJSON ?? "{}").font(.system(size: 11, design: .monospaced)).textSelection(.enabled).padding(16).frame(maxWidth: .infinity, alignment: .leading) }
                        .background(Palette.background)
                }.padding(28).frame(width: 760, height: 580).background(Palette.paper)
            }
            .sheet(isPresented: $showServer, onDismiss: {
                if let connection = pendingLocalConnection {
                    store.prefillLocalServer(connection)
                    pendingLocalConnection = nil
                }
            }) {
                ServerSettingsView(projectID: store.projectID, onConnect: { connection in
                    pendingLocalConnection = connection
                    showServer = false
                })
            }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
    }

    private func syncRow<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 14) {
            Text(title).frame(width: 80, alignment: .leading)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private struct SyncFieldStyle: TextFieldStyle {
        func _body(configuration: TextField<Self._Label>) -> some View {
            configuration
                .textFieldStyle(.plain)
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Palette.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.line, lineWidth: 1))
        }
    }
}

struct RecoveryView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.dismiss) var dismiss
    @State private var restoring: URL?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { Text("恢复副本").font(.custom("Songti SC", size: 27)); Spacer(); Button("完成") { dismiss() } }
            Text("导入或恢复前保留当前完整工作区。恢复会断开同步，并再保存一次当前内容。 ")
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            if store.recoveryFiles.isEmpty {
                EmptyState(symbol: "clock.arrow.circlepath", title: "尚无恢复副本", message: "第一次导入或恢复时，当前工作区会自动留在这里。")
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        ForEach(store.recoveryFiles, id: \.path) { url in
                            HStack {
                                Label(url.deletingPathExtension().lastPathComponent, systemImage: "doc.badge.clock").font(.system(size: 11, design: .monospaced))
                                Spacer()
                                Button("导出") { store.exportRecovery(url) }
                                Button("恢复") { restoring = url }
                            }.padding(16).background(Palette.background.opacity(0.7))
                        }
                    }
                }
            }
        }.padding(28).frame(width: 700, height: 470).background(Palette.paper)
            .confirmationDialog("恢复这份工程？", isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } })) {
                Button("保留当前副本并恢复") { if let url = restoring { store.restoreRecovery(url) }; restoring = nil }
                Button("取消", role: .cancel) { restoring = nil }
            }
    }
}

struct ReviewSettingsView: View {
    @EnvironmentObject var store: WorkspaceStore
    @Environment(\.dismiss) var dismiss
    @State private var algorithm = "adaptive"
    @State private var dailyLimit = 20
    @State private var fixedDays = 3
    @State private var intensity = 1.0
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("复习节奏").font(.custom("Songti SC", size: 28))
            Form {
                Picker("排期方式", selection: $algorithm) {
                    Text("自适应（FSRS 启发式）").tag("adaptive"); Text("固定间隔").tag("fixed")
                }
                Stepper("每日上限：\(dailyLimit)", value: $dailyLimit, in: 0...1000)
                if algorithm == "fixed" { Stepper("已掌握后间隔：\(fixedDays) 天", value: $fixedDays, in: 1...3650) }
                Picker("强度", selection: $intensity) {
                    Text("轻松").tag(0.75); Text("适中").tag(1.0); Text("密集").tag(1.5)
                }
            }.formStyle(.grouped)
            Text("离线排期、自主评价。自适应算法为工程中的启发式实现，尚非完整 FSRS 模型。")
                .font(.system(size: 11)).foregroundStyle(Palette.muted).lineSpacing(5)
            HStack { Spacer(); Button("取消") { dismiss() }; Button("保存") {
                if store.action("setReviewSettings", ["settings": ["algorithm": algorithm, "dailyLimit": dailyLimit,
                    "fixedDays": fixedDays, "intensity": intensity]]) { dismiss() }
            }.buttonStyle(PrimaryButton()) }
        }.padding(30).frame(width: 500, height: 390).background(Palette.paper)
            .onAppear {
                let settings = store.snapshot?.settings["reviewSettings"]?.objectValue ?? [:]
                algorithm = settings["algorithm"]?.stringValue ?? "adaptive"
                if case .number(let value) = settings["dailyLimit"] { dailyLimit = Int(value) }
                if case .number(let value) = settings["fixedDays"] { fixedDays = Int(value) }
                if case .number(let value) = settings["intensity"] { intensity = value }
            }
    }
}
