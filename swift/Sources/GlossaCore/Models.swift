import Foundation

public enum JSONValue: Codable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
    public var stringValue: String? { if case .string(let value) = self { return value }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let value) = self { return value }; return nil }
}

public struct CoreSnapshot: Decodable {
    public let projectID: String
    public let operationCount: Int
    public let notes: [CoreNote]
    public let folders: [CoreFolder]
    public let conflicts: [CoreConflict]
    public let corrections: [CoreCorrection]
    public let events: [CoreOperation]
    public let settings: [String: JSONValue]
    public let reviewCards: [CoreReviewCard]
    public let dueBlockIDs: [String]
    public let nativeSourcesJSON: String
}
public struct CoreBounds: Decodable {
    public let x: Double, y: Double, width: Double, height: Double
}
public struct CorePoint: Decodable {
    public let x: Double, y: Double, pressure: Double, tiltX: Double, tiltY: Double, time: Double
}
public struct CorePaperObject: Decodable, Identifiable {
    public let id: String, pageId: String, kind: String, layerId: String, version: String
    public let bounds: CoreBounds
    public let points: [CorePoint]?
    public let text: String?, color: String?, data: String?, revisionId: String?
    public let width: Double?
    public let deleted: Bool?
    public let replacesObjectIds: [String]?
}
public struct CorePage: Decodable, Identifiable {
    public let id: String, size: String, orientation: String, template: String
    public let width: Double, height: Double
    public let objects: [CorePaperObject]
}
public struct CoreCharacter: Decodable, Identifiable {
    public let id: String, value: String, version: String, order: String
    public let deleted: Bool
    public let afterId: String?
    public let sourceObjectIds: [String]?, glyphIds: [String]?
}
public struct CoreSourceMapping: Decodable {
    public let status: String, precision: String, evidence: String
    public let objectIds: [String]
    public let reason: String?
    public let confidence: Double
    public let objectVersions: [String: String]
}
public struct CoreSegment: Decodable, Identifiable {
    public let id: String, blockId: String, kind: String, text: String
    public let chars: [CoreCharacter]
    public let source: CoreSourceMapping
    public let deleted: Bool?
    public let preview: String?
}
public struct CoreBlockVersion: Decodable {
    public let eventId: String, segmentId: String, text: String
    public let at: Double
}
public struct CoreBlock: Decodable, Identifiable {
    public let id: String, title: String
    public let pageIds: [String], objectIds: [String], relatedBlockIds: [String]
    public let segments: [CoreSegment]
    public let versions: [CoreBlockVersion]
}
public struct CoreNote: Decodable, Identifiable {
    public let id: String, title: String
    public let pages: [CorePage]
    public let blocks: [CoreBlock]
    public let folderId: String?
    public let tags: [String]
    public let createdAt: Double, modifiedAt: Double
}
public struct CoreFolder: Decodable, Identifiable {
    public let id: String, name: String
    public let subject: String?
}
public struct CoreConflict: Decodable, Identifiable {
    public let id: String, kind: String, noteId: String, current: String, incoming: String
    public let currentEventId: String, incomingEventId: String
    public let segmentId: String?, charId: String?, objectId: String?
    public let resolved: Bool?
}
public struct CoreCorrection: Decodable, Identifiable {
    public let id: String, eventId: String, noteId: String, segmentId: String, objectId: String
    public let before: String, after: String, mode: String, status: String, reason: String
    public let needsPlacement: Bool?
    public let objectIds: [String]?
}
public struct CoreOperation: Decodable, Identifiable {
    public let id: String, deviceId: String, role: String, type: String
    public let seq: Int, clock: Int
    public let at: Double
    public let payload: [String: JSONValue]
    public let seen: [String: Int]?
}
public struct CoreReviewHistory: Decodable {
    public let at: Double, intervalDays: Double
    public let known: Bool
    public let algorithm: String
}
public struct CoreReviewCard: Decodable, Identifiable {
    public var id: String { blockId }
    public let blockId: String, noteId: String
    public let modifiedAt: Double, dueAt: Double, difficulty: Double, importance: Double, stability: Double
    public let reviews: Int, lapses: Int
    public let subject: String?
    public let lastReviewedAt: Double?
    public let history: [CoreReviewHistory]
}
