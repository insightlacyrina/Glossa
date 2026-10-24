import Foundation
import CryptoKit

public struct AIProxyLimits: Decodable, Sendable {
    public let maxObjects: Int, maxPlainBytes: Int, maxTTLSeconds: Int
}
public struct AIProxyStatus: Decodable, Sendable {
    public let aiProxyAvailable: Bool
    public let aiTemporaryPlaintextAccess: Bool
    public let endpoint: String?, model: String?
    public let limits: AIProxyLimits
}
public struct AIProxyScope: Codable, Sendable, Equatable {
    public let id: String, version: String
}
public struct AIProxyGrant: Decodable, Sendable {
    public let grantId: String, projectId: String, purpose: String
    public let objects: [AIProxyScope]
    public let expiresAt: Double
    public let serverPublicKey: String, salt: String, endpoint: String, model: String
    public let temporaryPlaintextAccess: Bool
}
public struct AIProxyCandidateObject: Decodable, Identifiable, Sendable {
    public let id: String, version: String, text: String
    public let uncertainty: [String]
}
public struct AIProxyCandidate: Decodable, Sendable {
    public let grantId: String, jobId: String, projectId: String
    public let candidate: Bool
    public let objects: [AIProxyCandidateObject]
}
public struct AIProxyPoint: Encodable, Sendable {
    let x: Double, y: Double, pressure: Double, tiltX: Double, tiltY: Double, time: Double
}
public struct AIProxyObject: Encodable, Identifiable, Sendable {
    public let id: String, version: String, kind: String
    public let text: String?
    let points: [AIProxyPoint]?
    public init(_ object: CorePaperObject) throws {
        guard ["text", "formula", "stroke"].contains(object.kind) else { throw NativeSyncError("INVALID_OBJECT", "仅能选择文字、公式或笔迹对象") }
        id = object.id; version = object.version; kind = object.kind
        text = object.kind == "stroke" ? nil : object.text ?? ""
        points = object.kind == "stroke" ? object.points?.map { AIProxyPoint(x: $0.x, y: $0.y, pressure: $0.pressure, tiltX: $0.tiltX, tiltY: $0.tiltY, time: $0.time) } : nil
        if object.kind == "stroke" && (points?.isEmpty ?? true) { throw NativeSyncError("INVALID_OBJECT", "笔迹对象没有可发送的真实采样") }
    }
}
private final class NoAIRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Per-grant ephemeral keys only. This client never reads/sends SyncConfiguration.passphrase.
/// Wire contract is documented in server/ai-proxy.mjs; no long-term E2EE key is involved.
public actor AIProxyClient {
    private let session: URLSession
    private let redirects = NoAIRedirects()
    private var keys: [String: SymmetricKey] = [:]
    private var envelopes: [String: (id: String, fingerprint: Data, data: Data, responseKey: SymmetricKey)] = [:]
    private var expiryTasks: [String: Task<Void, Never>] = [:]
    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 40; config.timeoutIntervalForResource = 45
        config.httpCookieStorage = nil; config.urlCache = nil
        session = URLSession(configuration: config, delegate: redirects, delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func status(configuration: SyncConfiguration) async throws -> AIProxyStatus {
        try await request(configuration, path: "api/ai/status", method: "GET", data: nil)
    }
    public func createGrant(configuration: SyncConfiguration, objects: [AIProxyObject], ttlSeconds: Int,
                            consent: Bool, expectedEndpoint: String, expectedModel: String) async throws -> AIProxyGrant {
        guard consent, !objects.isEmpty, Set(objects.map(\.id)).count == objects.count else { throw NativeSyncError("CONSENT_REQUIRED", "请明确选择本次授权对象并勾选临时解密授权") }
        let privateKey = P256.KeyAgreement.PrivateKey()
        let scope = objects.map { AIProxyScope(id: $0.id, version: $0.version) }
        let payload: [String: Any] = ["projectId": configuration.projectID, "purpose": "transcribe", "objects": scope.map { ["id": $0.id, "version": $0.version] },
            "ttlSeconds": ttlSeconds, "consent": true, "clientPublicKey": privateKey.publicKey.x963Representation.base64EncodedString()]
        let grant: AIProxyGrant = try await request(configuration, path: "api/ai/grants", method: "POST", data: JSONSerialization.data(withJSONObject: payload))
        guard grant.projectId == configuration.projectID, grant.purpose == "transcribe", grant.objects == scope,
              grant.temporaryPlaintextAccess, grant.endpoint == expectedEndpoint, grant.model == expectedModel,
              grant.expiresAt > Date().timeIntervalSince1970 * 1000, grant.expiresAt <= Date().timeIntervalSince1970 * 1000 + Double(ttlSeconds + 5) * 1000,
              let publicBytes = Data(base64Encoded: grant.serverPublicKey), let salt = Data(base64Encoded: grant.salt), salt.count == 32 else {
            try? await revoke(configuration: configuration, grantID: grant.grantId)
            throw NativeSyncError("GRANT_MISMATCH", "服务器授权范围或目标已改变，未发送对象内容")
        }
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: publicBytes)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        keys[grant.grantId] = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data(("glossa-ai-proxy-v1\0" + grant.grantId + "\0" + grant.projectId).utf8), outputByteCount: 32)
        let grantID = grant.grantId
        let delay = max(0, grant.expiresAt / 1000 - Date().timeIntervalSince1970)
        expiryTasks[grantID] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            await self?.forget(grantID)
        }
        return grant
    }
    private func forget(_ grantID: String) {
        keys.removeValue(forKey: grantID); envelopes.removeValue(forKey: grantID)
        expiryTasks.removeValue(forKey: grantID)?.cancel()
    }
    public func submit(configuration: SyncConfiguration, grant: AIProxyGrant, objects: [AIProxyObject], jobID: String) async throws -> AIProxyCandidate {
        guard grant.projectId == configuration.projectID, objects.map({ AIProxyScope(id: $0.id, version: $0.version) }) == grant.objects,
              Date().timeIntervalSince1970 * 1000 < grant.expiresAt else { throw NativeSyncError("SCOPE_MISMATCH", "临时授权范围已改变或已过期，原稿未修改") }
        struct Payload: Encodable { let projectId: String; let purpose: String; let objects: [AIProxyObject] }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let plaintext = try encoder.encode(Payload(projectId: grant.projectId, purpose: "transcribe", objects: objects))
        let fingerprint = Data(SHA256.hash(data: plaintext))
        let envelope: Data
        let responseKey: SymmetricKey
        if let existing = envelopes[grant.grantId] {
            guard existing.id == jobID, existing.fingerprint == fingerprint else { throw NativeSyncError("JOB_ID_COLLISION", "同一临时授权不能提交不同任务") }
            envelope = existing.data; responseKey = existing.responseKey
        } else {
            guard let key = keys.removeValue(forKey: grant.grantId) else { throw NativeSyncError("GRANT_REVOKED", "临时密钥已撤销，请重新授权") }
            responseKey = key
            let aad = try JSONSerialization.data(withJSONObject: ["glossa-ai-proxy-v1", grant.grantId, grant.projectId, "transcribe"], options: [.withoutEscapingSlashes])
            let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad)
            let iv = sealed.nonce.withUnsafeBytes { Data($0) }
            envelope = try JSONSerialization.data(withJSONObject: ["jobId": jobID, "iv": iv.base64EncodedString(), "data": (sealed.ciphertext + sealed.tag).base64EncodedString()])
            envelopes[grant.grantId] = (jobID, fingerprint, envelope, responseKey)
        }
        struct EncryptedCandidate: Decodable { let grantId: String; let jobId: String; let encryption: String; let iv: String; let data: String }
        let wire: EncryptedCandidate = try await request(configuration, path: "api/ai/grants/" + grant.grantId + "/jobs", method: "POST", data: envelope)
        guard wire.grantId == grant.grantId, wire.jobId == jobID, wire.encryption == "aes-256-gcm",
              let iv = Data(base64Encoded: wire.iv), iv.count == 12, let encrypted = Data(base64Encoded: wire.data), encrypted.count >= 16 else {
            throw NativeSyncError("INVALID_ENVELOPE", "AI 候选响应未通过临时加密格式检查")
        }
        let resultAAD = try JSONSerialization.data(withJSONObject: ["glossa-ai-proxy-v1", grant.grantId, grant.projectId, "candidate", jobID], options: [.withoutEscapingSlashes])
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16))
        let plaintextResult = try AES.GCM.open(box, using: responseKey, authenticating: resultAAD)
        let candidate = try JSONDecoder().decode(AIProxyCandidate.self, from: plaintextResult)
        guard candidate.grantId == grant.grantId, candidate.jobId == jobID, candidate.projectId == grant.projectId, candidate.candidate,
              candidate.objects.map({ AIProxyScope(id: $0.id, version: $0.version) }).sorted(by: { $0.id < $1.id }) == grant.objects.sorted(by: { $0.id < $1.id }) else {
            throw NativeSyncError("PROVIDER_SCOPE_MISMATCH", "模型返回的对象身份不符合授权；结果未应用")
        }
        return candidate
    }
    public func revoke(configuration: SyncConfiguration, grantID: String) async throws {
        forget(grantID)
        struct Revocation: Decodable { let revoked: Bool }
        let _: Revocation = try await request(configuration, path: "api/ai/grants/" + grantID + "/revoke", method: "POST", data: Data("{}".utf8), acceptRevocation: true)
    }
    private func request<T: Decodable>(_ config: SyncConfiguration, path: String, method: String, data: Data?, acceptRevocation: Bool = false) async throws -> T {
        let base = try NativeSyncClient.validatedURL(config)
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method; request.httpBody = data
        request.setValue("Bearer " + config.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw NativeSyncError("INVALID_RESPONSE", "AI 代理未返回有效响应") }
        guard (200..<300).contains(response.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let code = object?["error"] as? String ?? "HTTP_ERROR"
            if acceptRevocation && ["GRANT_REVOKED", "GRANT_EXPIRED", "GRANT_NOT_FOUND"].contains(code) {
                return try JSONDecoder().decode(T.self, from: Data("{\"revoked\":true}".utf8))
            }
            let messages = ["AI_PROXY_UNAVAILABLE": "此服务器尚未配置 AI 代理，请先在本机服务面板配置目标模型。",
                "UNAUTHORIZED": "服务器访问令牌无效", "GRANT_EXPIRED": "本次授权已过期，原稿仍保留", "GRANT_REVOKED": "本次授权已撤销",
                "PROVIDER_UNAUTHORIZED": "模型服务密钥无效，请在本机服务面板更新", "PROVIDER_RATE_LIMITED": "模型服务限流，请稍后重新授权",
                "PROVIDER_TIMEOUT": "模型服务超时，原稿未修改", "PROVIDER_BAD_JSON": "模型未返回规定的候选格式，原稿未修改",
                "PROVIDER_SCOPE_MISMATCH": "模型返回的对象身份不符合授权，结果未应用"]
            throw NativeSyncError(code, messages[code] ?? "AI 代理未完成：\(code)，原稿未修改")
        }
        guard data.count <= 3 * 1024 * 1024 else { throw NativeSyncError("PAYLOAD_TOO_LARGE", "AI 响应超过容量，未应用结果") }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
