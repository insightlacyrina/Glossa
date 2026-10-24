import Foundation
import Security

/// Sync bearer tokens are scoped to the server/project and stored in macOS Keychain.
/// E2EE passphrases are deliberately never stored here.
public enum NativeSecrets {
    private static let service = "com.glossa.native.sync"
    public static func token(for account: String) throws -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw secretError(status)
        }
        return token
    }
    public static func setToken(_ token: String, for account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account]
        if token.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw secretError(status) }
            return
        }
        let value: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        let updated = SecItemUpdate(query as CFDictionary, value as CFDictionary)
        if updated == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = Data(token.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw secretError(added) }
        } else if updated != errSecSuccess { throw secretError(updated) }
    }
    private static func secretError(_ status: OSStatus) -> Error {
        NativeSyncError("KEYCHAIN_ERROR", "无法访问同步令牌钥匙串（\(status)）；请解锁钥匙串后重试")
    }
}
