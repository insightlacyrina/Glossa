import SwiftUI
import AppKit
import GlossaCore

/// Explicit per-job authorization. Configuring a provider does not authorize sending notes.
struct AIProxyView: View {
    @Environment(\.dismiss) private var dismiss
    let note: CoreNote
    let configuration: SyncConfiguration
    @State private var client = AIProxyClient()
    @State private var status: AIProxyStatus?
    @State private var selected: Set<String> = []
    @State private var consent = false
    @State private var ttl = 120
    @State private var grant: AIProxyGrant?
    @State private var result: AIProxyCandidate?
    @State private var running = false
    @State private var message = "正在读取服务器的实际模型配置…"
    @State private var work: Task<Void, Never>?
    @State private var runID = UUID()
    private var objects: [CorePaperObject] { note.pages.flatMap(\.objects).filter { ["text", "formula", "stroke"].contains($0.kind) } }
    private var chosen: [CorePaperObject] { objects.filter { selected.contains($0.id) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("临时 AI 转录").font(.custom("Songti SC", size: 27)); Spacer(); Button("关闭") { cancelAndRevoke(); dismiss() }.keyboardShortcut(.cancelAction) }
            Text("仅发送你本次选中的对象，目的为忠实转录。Mac 服务器会临时解密这些必要内容并交给下列模型；长期工程加密口令和密钥不会发给服务器。")
                .font(.system(size: 12)).foregroundStyle(Palette.muted).lineSpacing(5)
            if let status, status.aiProxyAvailable {
                VStack(alignment: .leading, spacing: 6) {
                    Text("目标：\(status.endpoint ?? "")").textSelection(.enabled)
                    Text("模型：\(status.model ?? "") · 每次至多 \(status.limits.maxObjects) 个对象 · \(status.limits.maxPlainBytes / 1024) KiB")
                    HStack { Text("授权有效期")
                        Picker("授权有效期", selection: $ttl) { ForEach([30, 60, 120, 300].filter { $0 <= status.limits.maxTTLSeconds }, id: \.self) { Text("\($0) 秒").tag($0) } }.labelsHidden().frame(width: 140).disabled(running)
                    }
                }.font(.system(size: 11)).padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Palette.background)
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(objects) { object in
                            Toggle(isOn: Binding(get: { selected.contains(object.id) }, set: { value in
                                if value { selected.insert(object.id) } else { selected.remove(object.id) }; consent = false
                            })) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(object.kind == "stroke" ? "笔迹 · \(object.points?.count ?? 0) 个真实采样点" : String((object.text ?? "空白文字").prefix(110)))
                                        .font(.system(size: 12)).lineLimit(3)
                                    Text("\(object.id) · 版本 \(object.version)").font(.system(size: 9, design: .monospaced)).foregroundStyle(Palette.muted).lineLimit(2)
                                }
                            }.toggleStyle(.checkbox).disabled(running).padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Palette.paper)
                        }
                    }
                }.frame(minHeight: 135, maxHeight: 230)
                Toggle("我明确授权：仅为本次转录，临时解密并发送以上 \(chosen.count) 个对象；我理解服务器及模型会接触这些明文。", isOn: $consent)
                    .toggleStyle(.checkbox).font(.system(size: 11)).disabled(running)
                Text("撤销会取消后续处理与在途请求；已送达模型的内容无法从模型方撤回。")
                    .font(.system(size: 10)).foregroundStyle(Palette.muted)
                if let result {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 15) {
                            Text("候选预览 · 尚未修改 A / B").font(.headline)
                            ForEach(result.objects) { object in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(object.text).textSelection(.enabled)
                                    ForEach(Array(object.uncertainty.enumerated()), id: \.offset) { _, reason in Text(reason).font(.system(size: 10)).foregroundStyle(Palette.muted) }
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    }.frame(maxHeight: 180).background(Palette.background)
                }
                HStack {
                    Text(message).font(.system(size: 10)).foregroundStyle(Palette.muted).lineLimit(3)
                    Spacer()
                    if running || grant != nil { Button(running ? "取消并撤销" : "撤销授权") { cancelAndRevoke() }.buttonStyle(QuietButton()) }
                    if let result { Button("复制候选") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(result.objects.map(\.text).joined(separator: "\n\n"), forType: .string) }.buttonStyle(QuietButton()) }
                    Button("授权并开始") { start() }.buttonStyle(PrimaryButton())
                        .disabled(running || !consent || chosen.isEmpty || chosen.count > status.limits.maxObjects)
                }
            } else {
                EmptyState(symbol: "lock.shield", title: "AI 代理尚未可用", message: message)
                Text("先在本机服务面板配置模型地址、模型与 API 密钥，再保存连接。配置完成仍需在这里逐次选择对象并授权。")
                    .font(.system(size: 11)).foregroundStyle(Palette.muted)
            }
        }.padding(28).frame(width: 740, height: 790).background(Palette.paper)
            .task {
                do {
                    let actual = try await client.status(configuration: configuration)
                    status = actual
                    ttl = min(120, actual.limits.maxTTLSeconds)
                    if ![30, 60, 120, 300].contains(ttl) { ttl = [30, 60, 120, 300].filter { $0 <= actual.limits.maxTTLSeconds }.last ?? actual.limits.maxTTLSeconds }
                    message = actual.aiProxyAvailable ? "选择具体对象后，才会发送本次必要内容。" : "服务器未启用临时 AI 代理。原稿继续离线可用。"
                } catch { message = error.localizedDescription }
            }
            .onDisappear { cancelAndRevoke() }
    }
    private func start() {
        guard let status, let endpoint = status.endpoint, let model = status.model else { return }
        let captured = chosen
        let identity = UUID(); runID = identity
        running = true; result = nil; message = "正在建立本次临时授权…"
        work = Task {
            var acquired: AIProxyGrant?
            do {
                let selectedObjects = try captured.map { try AIProxyObject($0) }
                let next = try await client.createGrant(configuration: configuration, objects: selectedObjects, ttlSeconds: ttl,
                    consent: consent, expectedEndpoint: endpoint, expectedModel: model)
                acquired = next
                guard identity == runID, !Task.isCancelled else { try? await client.revoke(configuration: configuration, grantID: next.grantId); return }
                grant = next; message = "已授权 \(selectedObjects.count) 个对象，模型处理中；可以随时撤销。"
                let candidate = try await client.submit(configuration: configuration, grant: next, objects: selectedObjects, jobID: UUID().uuidString)
                guard identity == runID, !Task.isCancelled else { return }
                result = candidate
                do {
                    try await client.revoke(configuration: configuration, grantID: next.grantId)
                    grant = nil
                    message = "候选已保留在本机预览；服务器已确认本次授权结束。请人工核对不确定项。"
                } catch {
                    message = "候选已保留在本机预览；撤销尚未获服务器确认，可重试撤销，或等待本次短期授权自动过期。"
                }
                consent = false; running = false
            } catch {
                if let acquired { try? await client.revoke(configuration: configuration, grantID: acquired.grantId) }
                guard identity == runID else { return }
                running = false; grant = nil; consent = false
                message = Task.isCancelled ? "已取消，原稿及本地内容未修改。" : error.localizedDescription
            }
        }
    }
    private func cancelAndRevoke() {
        runID = UUID(); work?.cancel(); work = nil
        let active = grant; grant = nil; running = false; consent = false
        message = "已取消；撤销请求会发往服务器，无法联机时本次授权仍会在短期内自动过期。原稿未修改。"
        if let active { Task { try? await client.revoke(configuration: configuration, grantID: active.grantId) } }
    }
}
