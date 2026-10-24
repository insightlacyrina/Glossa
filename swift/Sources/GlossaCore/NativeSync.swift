import Foundation
import CryptoKit
import CommonCrypto
import JavaScriptCore

public struct SyncConfiguration: Sendable {
    public var url: String
    public var token: String
    public var projectID: String
    public var mode: String
    public var passphrase: String
    public init(url: String, token: String, projectID: String, mode: String = "plain", passphrase: String = "") {
        self.url = url; self.token = token; self.projectID = projectID
        self.mode = mode; self.passphrase = passphrase
    }
}

public struct SyncResult: Sendable {
    public let operationsJSON: String
    public let cursor: Int
    public let acknowledgedIDs: [String]
    public let generation: String
    public init(operationsJSON: String, cursor: Int, acknowledgedIDs: [String], generation: String) {
        self.operationsJSON = operationsJSON; self.cursor = cursor
        self.acknowledgedIDs = acknowledgedIDs; self.generation = generation
    }
}

public struct NativeSyncError: LocalizedError, Sendable {
    public let code: String
    public let message: String
    public var errorDescription: String? { message }
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

private final class NoSyncRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        // Never forward a bearer token or note contents to a redirect target.
        completionHandler(nil)
    }
}

/// Native transport for the existing immutable-operation protocol. No local state is
/// changed here: persist merged operations before committing the returned cursor/acks.
public final class NativeSyncClient: @unchecked Sendable {
    private let session: URLSession
    private let redirects = NoSyncRedirects()
    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 60
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    public func synchronize(configuration: SyncConfiguration, operationsJSON: String,
                            cursor: Int, acknowledgedIDs: [String], generation: String?) async throws -> SyncResult {
        let base = try Self.validatedURL(configuration)
        guard cursor >= 0, cursor <= 9_007_199_254_740_991 else { throw NativeSyncError("INVALID_CURSOR", "本地同步游标无效") }
        let codec = try SyncCodec(configuration: configuration)
        guard let all = try JSONSerialization.jsonObject(with: Data(operationsJSON.utf8)) as? [[String: Any]] else {
            throw NativeSyncError("INVALID_OPERATIONS", "本地操作日志无效；未修改同步记录")
        }
        var unique: [String: String] = [:]
        for operation in all {
            guard let id = operation["id"] as? String, Self.validID(id) else { throw NativeSyncError("INVALID_OPERATION", "本地操作身份无效") }
            let encoded = try codec.canonical(operation)
            if let previous = unique[id], previous != encoded { throw NativeSyncError("OP_ID_COLLISION", "本地操作身份冲突；已停止同步以保护数据") }
            unique[id] = encoded
        }
        var lastError: Error = NativeSyncError("SERVER_GENERATION_CHANGED", "服务器持续重启，未确认操作仍保留")
        var forceReplay = false
        for _ in 0..<3 {
            try Task.checkCancellation()
            let status = try await request(configuration, base: base, path: "api/status", body: nil)
            guard Self.integer(status["protocol"]) == 1,
                  let boot = status["generation"] as? String, Self.validID(boot) else {
                throw NativeSyncError("INVALID_RESPONSE", "同步服务器缺少有效恢复世代；未修改本地数据")
            }
            let replay = forceReplay || boot != generation || acknowledgedIDs.isEmpty
            let known = replay ? Set<String>() : Set(acknowledgedIDs)
            let pending = all.filter { !known.contains($0["id"] as? String ?? "") }
            do {
                let result = try await exchange(configuration, base: base, codec: codec, operations: pending,
                                                cursor: replay ? 0 : cursor, generation: boot)
                return SyncResult(operationsJSON: result.operationsJSON, cursor: result.cursor,
                                  acknowledgedIDs: Array(known.union(result.acknowledgedIDs)).sorted(), generation: boot)
            } catch let error as NativeSyncError where ["CURSOR_AHEAD", "SERVER_GENERATION_CHANGED"].contains(error.code) {
                forceReplay = true; lastError = error
            }
        }
        throw lastError
    }

    private func exchange(_ config: SyncConfiguration, base: URL, codec: SyncCodec,
                          operations: [[String: Any]], cursor: Int, generation: String) async throws -> SyncResult {
        let maxBytes = 24 * 1024 * 1024
        let overhead = requestBody(config, codec: codec, envelopes: [], cursor: 9_007_199_254_740_991,
                                   generation: String(repeating: "0", count: 180)).utf8.count
        var currentCursor = cursor
        var received: [String: String] = [:]
        var receivedOrder: [String] = []
        var acknowledged = Set<String>()

        func uploadAndDrain(_ chunk: [String]) async throws {
            var uploaded = false
            var more = true
            while more {
                try Task.checkCancellation()
                let pending = uploaded ? [] : chunk
                let body = requestBody(config, codec: codec, envelopes: pending, cursor: currentCursor, generation: generation)
                let result: [String: Any]
                do {
                    result = try await request(config, base: base, path: "api/sync", body: Data(body.utf8))
                } catch let error as NativeSyncError where error.code == "PAYLOAD_TOO_LARGE" {
                    guard pending.count > 1 else { throw NativeSyncError("PAYLOAD_TOO_LARGE", "单个操作超过服务器接收容量；原始内容及待同步队列已保留") }
                    let middle = (pending.count + 1) / 2
                    try await uploadAndDrain(Array(pending[..<middle]))
                    try await uploadAndDrain(Array(pending[middle...]))
                    return
                }
                guard Self.integer(result["protocol"]) == 1,
                      let boot = result["generation"] as? String, Self.validID(boot) else {
                    throw NativeSyncError("INVALID_RESPONSE", "同步服务器响应无效；未修改本地数据")
                }
                guard boot == generation else { throw NativeSyncError("SERVER_GENERATION_CHANGED", "同步服务器已重启，将重新校验本地操作") }
                guard let envelopes = result["ops"] as? [[String: Any]],
                      let next = Self.integer(result["cursor"]), next >= currentCursor,
                      let hasMore = Self.boolean(result["hasMore"]),
                      let accepted = result["accepted"] as? [String] else {
                    throw NativeSyncError("INVALID_RESPONSE", "同步服务器响应无效；未修改本地数据")
                }
                if hasMore && next == currentCursor { throw NativeSyncError("INVALID_RESPONSE", "同步游标未前进") }
                for envelope in envelopes {
                    let decoded = try codec.decode(envelope)
                    guard let id = decoded["id"] as? String else { throw NativeSyncError("INVALID_RESPONSE", "同步操作缺少身份") }
                    let encoding = try codec.canonical(decoded)
                    if let prior = received[id], prior != encoding { throw NativeSyncError("OP_ID_COLLISION", "服务器返回不同内容的同身份操作；本地数据已保留") }
                    if received[id] == nil { receivedOrder.append(id) }
                    received[id] = encoding; acknowledged.insert(id)
                }
                let expected = Set(try pending.map { value -> String in
                    guard let object = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any], let id = object["id"] as? String else {
                        throw NativeSyncError("INVALID_OPERATION", "上传操作身份无效")
                    }
                    return id
                })
                guard Set(accepted) == expected else { throw NativeSyncError("INVALID_RESPONSE", "服务器未完整确认上传操作；待同步队列已保留") }
                acknowledged.formUnion(accepted)
                currentCursor = next; more = hasMore; uploaded = true
            }
        }

        var batch: [String] = []
        var bytes = overhead
        for operation in operations {
            let envelope = try codec.encode(operation)
            let size = envelope.utf8.count
            guard overhead + size <= maxBytes else { throw NativeSyncError("PAYLOAD_TOO_LARGE", "单个操作超过 24 MiB 同步容量；原始内容及待同步队列已保留，请导出完整工程") }
            if !batch.isEmpty && (batch.count >= 500 || bytes + 1 + size > maxBytes) {
                try await uploadAndDrain(batch); batch = []; bytes = overhead
            }
            bytes += size + (batch.isEmpty ? 0 : 1); batch.append(envelope)
        }
        if !batch.isEmpty || operations.isEmpty { try await uploadAndDrain(batch) }
        return SyncResult(operationsJSON: "[" + receivedOrder.compactMap { received[$0] }.joined(separator: ",") + "]",
                          cursor: currentCursor, acknowledgedIDs: Array(acknowledged).sorted(), generation: generation)
    }

    private func requestBody(_ config: SyncConfiguration, codec: SyncCodec, envelopes: [String], cursor: Int, generation: String) -> String {
        "{\"projectId\":" + SyncCodec.quote(config.projectID) + ",\"mode\":" + SyncCodec.quote(config.mode) +
        ",\"keyId\":" + (codec.keyID.map(SyncCodec.quote) ?? "null") + ",\"ops\":[" + envelopes.joined(separator: ",") +
        "],\"cursor\":\(cursor),\"generation\":" + SyncCodec.quote(generation) + "}"
    }

    private func request(_ config: SyncConfiguration, base: URL, path: String, body: Data?) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("Bearer " + config.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeSyncError("INVALID_RESPONSE", "同步服务器响应无效") }
        if http.statusCode == 413 { throw NativeSyncError("PAYLOAD_TOO_LARGE", "同步请求超过服务器接收容量") }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeSyncError("INVALID_RESPONSE", "同步服务器未返回有效 JSON（HTTP \(http.statusCode)）")
        }
        guard (200..<300).contains(http.statusCode) else {
            let code = json["error"] as? String ?? "HTTP_ERROR"
            let messages = ["UNAUTHORIZED": "同步令牌无效", "PROJECT_ENCRYPTION_MISMATCH": "工程加密模式或口令不匹配",
                            "CURSOR_AHEAD": "服务器备份早于本地记录，将重新校验操作", "SERVER_GENERATION_CHANGED": "同步服务器已重启，将重新校验操作",
                            "OP_ID_COLLISION": "操作身份冲突，已停止同步以保护数据", "ORIGIN_DENIED": "服务器拒绝此客户端来源"]
            throw NativeSyncError(code, messages[code] ?? "同步失败（HTTP \(http.statusCode)）：\(code)")
        }
        return json
    }

    static func validatedURL(_ config: SyncConfiguration) throws -> URL {
        guard !config.url.isEmpty, !config.token.isEmpty, validID(config.projectID), ["plain", "e2ee"].contains(config.mode),
              let parts = URLComponents(string: config.url), let url = parts.url,
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              !config.token.contains("\r"), !config.token.contains("\n") else {
            throw NativeSyncError("INVALID_CONFIGURATION", "请填写有效的服务器地址、访问令牌与工程标识")
        }
        guard scheme == "https" || ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) else {
            throw NativeSyncError("INSECURE_TRANSPORT", "远端同步必须使用 HTTPS；本机开发可以使用 HTTP")
        }
        return url
    }
    static func validID(_ string: String) -> Bool {
        string.range(of: "^[A-Za-z0-9_.:-]{1,180}$", options: .regularExpression) != nil
    }
    private static func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue,
              n.doubleValue >= 0, n.doubleValue <= 9_007_199_254_740_991 else { return nil }
        return n.intValue
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }
}

/// JavaScript's JSON number/string formatting and UTF-16 key ordering are part
/// of the established protocol. JSC avoids locale and NSNumber formatting drift.
final class SyncCodec {
    private let config: SyncConfiguration
    private let context: JSContext
    private var aes: SymmetricKey?
    private var hmac: SymmetricKey?
    private(set) var keyID: String?
    init(configuration: SyncConfiguration) throws {
        config = configuration
        guard let context = JSContext() else { throw NativeSyncError("ENCODING_FAILED", "无法启动同步编码器") }
        self.context = context
        context.evaluateScript("""
        function canonical(v) {
          if (v === null || typeof v !== 'object') return JSON.stringify(v);
          if (Array.isArray(v)) return '[' + v.map(x => canonical(x ?? null)).join(',') + ']';
          return '{' + Object.keys(v).sort((a,b) => a < b ? -1 : a > b ? 1 : 0)
            .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
        }
        function encodeJSON(input) { return canonical(JSON.parse(input)); }
        function plainJSON(input) { const op = JSON.parse(canonical(JSON.parse(input))); return JSON.stringify({id:op.id,mode:'plain',payload:op}); }
        """)
        if configuration.mode == "e2ee" {
            guard configuration.passphrase.utf16.count >= 12 else { throw NativeSyncError("PASSPHRASE_REQUIRED", "端到端加密口令至少需要 12 个字符") }
            let password = Array(configuration.passphrase.utf8)
            let salt = Array(("quiet-paper-sync-v1:" + configuration.projectID).utf8)
            var derived = [UInt8](repeating: 0, count: 64)
            let result = password.withUnsafeBytes { pass in
                salt.withUnsafeBytes { salt in
                    derived.withUnsafeMutableBytes { output in
                        CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pass.baseAddress?.assumingMemoryBound(to: Int8.self), password.count,
                                            salt.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                                            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 310_000,
                                            output.baseAddress?.assumingMemoryBound(to: UInt8.self), output.count)
                    }
                }
            }
            guard result == kCCSuccess else { throw NativeSyncError("KEY_DERIVATION_FAILED", "无法派生加密密钥") }
            aes = SymmetricKey(data: derived[0..<32]); hmac = SymmetricKey(data: derived[32..<64])
            keyID = Self.hex(SHA256.hash(data: Data(derived)))
            _ = derived.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
        }
    }
    func canonical(_ value: Any) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        guard let json = String(data: bytes, encoding: .utf8),
              let encoded = context.objectForKeyedSubscript("encodeJSON")?.call(withArguments: [json])?.toString(),
              context.exception == nil else { throw NativeSyncError("ENCODING_FAILED", "同步内容无法编码") }
        return encoded
    }
    func encode(_ operation: [String: Any]) throws -> String {
        let plaintext = try canonical(operation)
        guard let id = operation["id"] as? String else { throw NativeSyncError("INVALID_OPERATION", "操作缺少身份") }
        if config.mode == "plain" {
            guard let result = context.objectForKeyedSubscript("plainJSON")?.call(withArguments: [plaintext])?.toString(), context.exception == nil else {
                throw NativeSyncError("ENCODING_FAILED", "同步内容无法编码")
            }
            return result
        }
        guard let aes, let hmac else { throw NativeSyncError("KEY_REQUIRED", "需要解锁加密同步") }
        let data = Data(plaintext.utf8)
        let sealed = try AES.GCM.seal(data, using: aes, authenticating: Data((config.projectID + "\0" + id).utf8))
        let iv = sealed.nonce.withUnsafeBytes { Data($0) }.base64EncodedString()
        let ciphertext = (sealed.ciphertext + sealed.tag).base64EncodedString()
        let fingerprint = Self.hex(HMAC<SHA256>.authenticationCode(for: data, using: hmac))
        return "{\"id\":" + Self.quote(id) + ",\"mode\":\"e2ee\",\"iv\":" + Self.quote(iv) + ",\"data\":" + Self.quote(ciphertext) + ",\"fingerprint\":" + Self.quote(fingerprint) + "}"
    }
    func decode(_ envelope: [String: Any]) throws -> [String: Any] {
        guard let id = envelope["id"] as? String, NativeSyncClient.validID(id), envelope["mode"] as? String == config.mode else {
            throw NativeSyncError("INVALID_ENVELOPE", "同步身份或加密模式不匹配；已停止同步")
        }
        if config.mode == "plain" {
            guard let payload = envelope["payload"] as? [String: Any], payload["id"] as? String == id else {
                throw NativeSyncError("INVALID_ENVELOPE", "同步操作身份不一致")
            }
            return payload
        }
        do {
            guard let aes, let hmac, let iv = envelope["iv"] as? String, let nonce = Data(base64Encoded: iv), nonce.count == 12,
                  let encoded = envelope["data"] as? String, let data = Data(base64Encoded: encoded), data.count >= 16,
                  let fingerprint = envelope["fingerprint"] as? String else { throw NativeSyncError("INVALID_ENVELOPE", "加密数据无效") }
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: data.dropLast(16), tag: data.suffix(16))
            let plaintext = try AES.GCM.open(box, using: aes, authenticating: Data((config.projectID + "\0" + id).utf8))
            let expected = Self.hex(HMAC<SHA256>.authenticationCode(for: plaintext, using: hmac))
            guard expected == fingerprint, let operation = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any], operation["id"] as? String == id else {
                throw NativeSyncError("INVALID_ENVELOPE", "加密数据无效")
            }
            return operation
        } catch { throw NativeSyncError("DECRYPTION_FAILED", "加密数据验证失败；请检查口令或备份完整性") }
    }
    static func quote(_ value: String) -> String {
        // JSONSerialization is used for isolated protocol identifiers only. The
        // operation body itself always goes through the exact JSC serializer.
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        return String(data: data, encoding: .utf8)!
    }
    private static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
