import Foundation
import Testing
@testable import GlossaCore

struct LocalWorkspaceTests {
    @Test func testExclusiveOwnershipAndAtomicRecovery() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try LocalWorkspace(directory: directory)
        XCTAssertThrowsError(try LocalWorkspace(directory: directory))
        XCTAssertNil(try store.load())
        try store.save(SavedWorkspace(deviceID: "one", projectJSON: "old"))
        let recovery = try XCTUnwrap(store.preserveCurrent())
        var next = SavedWorkspace(deviceID: "one", projectJSON: "new")
        next.sync.cursor = 42; next.sync.acknowledgedIDs = ["op"]
        try store.save(next)
        XCTAssertEqual(try store.load()?.projectJSON, "new")
        XCTAssertEqual(try store.load()?.sync.cursor, 42)
        XCTAssertEqual(try store.readRecovery(recovery).projectJSON, "old")
    }
    @Test func testCorruptionIsReportedWithoutReplacement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try LocalWorkspace(directory: directory)
        let file = directory.appendingPathComponent("workspace.json")
        try Data("broken".utf8).write(to: file)
        XCTAssertThrowsError(try store.load())
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "broken")
        XCTAssertNotNil(try store.preserveCurrent())
    }
}
