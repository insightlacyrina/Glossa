import Foundation
import JavaScriptCore

public enum NativeCoreError: LocalizedError {
    case unavailable, missingResource, javascript(String), invalidResult
    public var errorDescription: String? {
        switch self {
        case .unavailable: return "无法启动本地数据内核"
        case .missingResource: return "应用缺少数据内核资源，请重新构建应用"
        case .javascript(let reason): return reason
        case .invalidResult: return "数据内核返回了无法读取的结果"
        }
    }
}

/// Synchronous local data engine. Keep one instance on the same serial thread.
/// JavaScriptCore executes shared data rules; all controls and rendering are native SwiftUI.
public final class NativeCore {
    private let context: JSContext
    private let api: JSValue
    private var exception: String?

    public init(deviceID: String) throws {
        guard let context = JSContext() else { throw NativeCoreError.unavailable }
        self.context = context
        let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        let utf8: @convention(block) (String) -> NSArray = { Array($0.utf8).map { NSNumber(value: $0) } as NSArray }
        context.setObject(uuid, forKeyedSubscript: "nativeUUID" as NSString)
        context.setObject(utf8, forKeyedSubscript: "nativeUTF8" as NSString)
        guard let url = Bundle.module.url(forResource: "core", withExtension: "js") else {
            throw NativeCoreError.missingResource
        }
        let source = try String(contentsOf: url, encoding: .utf8)
        context.evaluateScript(source, withSourceURL: url)
        if let error = context.exception { throw NativeCoreError.javascript(error.toString()) }
        guard let api = context.objectForKeyedSubscript("GlossaCore"), !api.isUndefined else {
            throw NativeCoreError.unavailable
        }
        self.api = api
        context.exceptionHandler = { [weak self] _, value in
            self?.exception = value?.toString() ?? "数据内核执行失败"
        }
        _ = try call("initialize", [deviceID])
    }

    private func call(_ method: String, _ arguments: [Any] = []) throws -> JSValue {
        exception = nil
        context.exception = nil
        let result = api.invokeMethod(method, withArguments: arguments)
        if let exception { throw NativeCoreError.javascript(exception) }
        guard let result else { throw NativeCoreError.invalidResult }
        return result
    }

    public func loadProject(_ json: String) throws { _ = try call("load", [json]) }
    public func projectJSON() throws -> String { try call("project").toString() }
    public func projectID() throws -> String { try call("projectID").toString() }
    public func operationsJSON() throws -> String { try call("operations").toString() }
    public func snapshot() throws -> CoreSnapshot {
        let json = try call("snapshot").toString() ?? ""
        return try JSONDecoder().decode(CoreSnapshot.self, from: Data(json.utf8))
    }
    public func mergeOperations(_ json: String) throws { _ = try call("merge", [json]) }
    public func invoke(_ action: String, _ args: [String: Any] = [:]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: args, options: [.fragmentsAllowed])
        return try call("invoke", [action, String(decoding: data, as: UTF8.self)]).toString()
    }
}
