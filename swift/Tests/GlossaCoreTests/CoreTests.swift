import Foundation
import Testing
@testable import GlossaCore

struct CoreTests {
    private func example() throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("examples/变化与积累.glossa"), encoding: .utf8)
    }
    private func loaded(_ device: String = "native-test") throws -> NativeCore {
        let engine = try NativeCore(deviceID: device)
        try engine.loadProject(example())
        return engine
    }
    private func expectedCharacters(_ segment: CoreSegment) -> [[String: String]] {
        segment.chars.filter { !$0.deleted }.map { ["id": $0.id, "version": $0.version, "value": $0.value] }
    }
    private func handwritingFixture() throws -> String {
        var operations: [[String: Any]] = []
        func append(_ type: String, _ payload: [String: Any]) {
            let seq = operations.count + 1
            operations.append(["id": "pen-fixture:\(seq)", "deviceId": "pen-fixture", "role": "tablet",
                "seq": seq, "clock": seq, "at": 1_792_600_000_000 + seq, "type": type,
                "seen": ["pen-fixture": seq - 1], "payload": payload])
        }
        func point(_ x: Double, _ y: Double, _ pressure: Double, _ time: Int) -> [String: Any] {
            ["x": x, "y": y, "pressure": pressure, "tiltX": 18, "tiltY": -4, "time": time]
        }
        append("note.create", ["noteId": "ink-note", "pageId": "ink-page", "title": "仿手写原生验收", "paper": [:]])
        append("object.create", ["noteId": "ink-note", "pageId": "ink-page", "object": [
            "id": "original-ink", "kind": "stroke", "layerId": "ink", "color": "#343434", "width": 3,
            "bounds": ["x": 40, "y": 60, "width": 140, "height": 40],
            "points": [point(40, 60, 0.25, 100), point(180, 80, 0.8, 145)]
        ]])
        append("object.create", ["noteId": "ink-note", "pageId": "ink-page", "object": [
            "id": "confirmed-b-ink", "kind": "stroke", "layerId": "ink", "color": "#343434", "width": 3,
            "bounds": ["x": 300, "y": 100, "width": 10, "height": 20],
            "points": [point(300, 100, 0.25, 100), point(310, 120, 0.8, 145)]
        ]])
        append("block.create", ["noteId": "ink-note", "blockId": "ink-block", "title": "文字", "objectIds": ["original-ink"]])
        append("segment.create", ["noteId": "ink-note", "blockId": "ink-block", "segmentId": "ink-segment",
            "objectIds": ["original-ink"], "text": "a", "options": ["confirmed": true, "kind": "text"]])
        // A tablet-confirmed normalized snapshot, with exact raw-source provenance.
        append("handwriting.learn", ["noteId": "ink-note", "glyph": [
            "character": "b", "noteId": "ink-note", "pageId": "ink-page",
            "sourceVersions": ["confirmed-b-ink": "pen-fixture:3"], "height": 20, "aspect": 0.5,
            "strokes": [["points": [point(0, 0, 0.25, 100), point(0.5, 1, 0.8, 145)],
                "width": 0.15, "color": "#343434"]]
        ]])
        let envelope: [String: Any] = ["format": "quiet-paper-project", "version": 1, "project": [
            "schemaVersion": 1, "id": "native-handwriting-fixture", "operations": operations, "metadata": [:]
        ]]
        return String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self)
    }
    @Test func testCompatibleRoundTripPreservesFullProject() throws {
        let core = try loaded()
        let before = try JSONSerialization.jsonObject(with: Data(example().utf8)) as! NSDictionary
        let exported = try JSONSerialization.jsonObject(with: Data(core.projectJSON().utf8)) as! NSDictionary
        XCTAssertEqual(before, exported)
        let snapshot = try core.snapshot()
        XCTAssertFalse(snapshot.notes.isEmpty)
        XCTAssertEqual(snapshot.operationCount, 71)
        XCTAssertFalse(snapshot.notes[0].pages[0].objects.isEmpty)
        XCTAssertFalse(snapshot.reviewCards.isEmpty)

        // Native UI models are deliberately a projection: export must retain
        // future metadata and complete source records that have no Swift fields.
        var richEnvelope = try XCTUnwrap(before as? [String: Any])
        var project = try XCTUnwrap(richEnvelope["project"] as? [String: Any])
        var metadata = try XCTUnwrap(project["metadata"] as? [String: Any])
        let futureValues: [Any] = [true, NSNull(), "保留😀", ["custom": 17]]
        metadata["future-native-extension"] = ["schema": 9, "nested": ["unknown": futureValues]] as [String: Any]
        project["metadata"] = metadata
        let sourceText = "# 原稿😀\n\n保留 $x^2$ 与空白。\n"
        let sourceObject: [String: Any] = ["id": "native-object-test", "kind": "source", "start": 0,
            "end": sourceText.utf16.count, "text": sourceText, "fingerprint": "test-source-fingerprint"]
        let history: [String: Any] = ["revision": 1, "name": "原稿.md", "text": "# 初稿\n",
            "objects": [sourceObject], "at": 1_792_500_000_000.0, "reason": "import"]
        let document: [String: Any] = ["schema": 1, "id": "native-source-test", "name": "原稿.md", "format": "markdown",
            "text": sourceText, "revision": 2, "fingerprint": "test-source-fingerprint", "objects": [sourceObject], "history": [history]]
        let link: [String: Any] = ["schema": 1, "id": "source:test", "sourceId": "native-source-test",
            "objectId": "native-object-test", "sourceName": "原稿.md", "sourceFingerprint": "test-source-fingerprint", "sourceRevision": 2,
            "baseContent": sourceText, "paperContent": "离线待写内容😀", "sourceSnapshot": document,
            "mode": "linked", "status": "pending", "offlineTimeoutMs": 604_800_000,
            "lastSourceContact": 1_792_500_000_000.0,
            "queued": [["id": "queued-test", "kind": "edit", "text": "离线待写内容😀", "at": 1_792_500_001_000.0]]]
        let pendingNative: [String: Any] = ["text": "离线待写内容😀", "sha256": "pending-test-sha", "baseSha256": "base-test-sha",
            "sourceText": sourceText, "sourceSha256": "source-test-sha", "reason": "source unavailable"]
        let plannedWrite: [String: Any] = ["id": "write-test", "document": document, "link": link,
            "expectedText": sourceText, "expectedSha256": "source-test-sha", "paperToken": "paper-token-test"]
        let sourceRecord: [String: Any] = ["document": document, "link": link,
            "noteId": snapshot.notes[0].id, "pageId": snapshot.notes[0].pages[0].id,
            "paperObjectId": snapshot.notes[0].pages[0].objects[0].id, "uri": "content://test/source.md",
            "sha256": "source-test-sha", "ownerDeviceId": "android-fixture",
            "pendingSource": ["document": document, "sha256": "external-test-sha", "reason": "external update"],
            "plannedWrite": plannedWrite, "pendingNative": pendingNative,
            "nativeResolution": ["id": "resolution-test", "text": "人工选择😀", "document": document,
                "expectedSourceText": sourceText, "expectedSourceSha256": "source-test-sha",
                "expectedPendingText": "离线待写内容😀", "expectedPendingSha256": "pending-test-sha"]]
        var operations = try XCTUnwrap(project["operations"] as? [[String: Any]])
        let clock = operations.compactMap { $0["clock"] as? Int }.max() ?? 0
        let at = operations.compactMap { $0["at"] as? Double }.max() ?? 0
        var seen: [String: Int] = [:]
        for operation in operations {
            if let device = operation["deviceId"] as? String, let seq = operation["seq"] as? Int { seen[device] = max(seen[device] ?? 0, seq) }
        }
        operations.append(["id": "native-preservation-fixture:1", "deviceId": "native-preservation-fixture", "role": "mac",
            "seq": 1, "clock": clock + 1, "at": at + 1, "type": "setting.set", "seen": seen,
            "payload": ["key": "source:test", "value": sourceRecord]])
        project["operations"] = operations
        richEnvelope["project"] = project
        let richData = try JSONSerialization.data(withJSONObject: richEnvelope)
        let richCore = try NativeCore(deviceID: "native-preservation-reader")
        try richCore.loadProject(String(decoding: richData, as: UTF8.self))
        let richExport = try JSONSerialization.jsonObject(with: Data(richCore.projectJSON().utf8)) as! NSDictionary
        XCTAssertEqual(richEnvelope as NSDictionary, richExport)
        let sourceJSON = try richCore.snapshot().nativeSourcesJSON
        let sourceViews = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sourceJSON.utf8)) as? [[String: Any]])
        let sourceView = try XCTUnwrap(sourceViews.first { ($0["document"] as? [String: Any])?["id"] as? String == "native-source-test" })
        XCTAssertEqual(sourceRecord as NSDictionary, sourceView as NSDictionary)
        XCTAssertTrue(sourceJSON.contains("离线待写内容😀"))
        XCTAssertEqual((sourceView["document"] as? [String: Any])?["text"] as? String, sourceText)
    }
    @Test func testMacCannotCreateNotesPagesOrBlocks() throws {
        let core = try loaded()
        let note = try XCTUnwrap(core.snapshot().notes.first)
        let before = try core.projectJSON()
        for action in ["createNote", "addPage", "createBlock"] {
            XCTAssertThrowsError(try core.invoke(action, ["noteID": note.id, "title": "禁止创建"]))
            XCTAssertEqual(try core.projectJSON(), before)
        }
    }
    @Test func testBRevisionUsesNativeSelectedRangeAndCreatesPrintedLayer() throws {
        let core = try loaded()
        let note = try XCTUnwrap(core.snapshot().notes.first)
        let segment = try XCTUnwrap(note.blocks.flatMap(\.segments).first { $0.kind == "text" && $0.deleted != true })
        let before = try core.snapshot().operationCount
        _ = try core.invoke("editRange", ["noteID": note.id, "segmentID": segment.id, "expectedText": segment.text, "start": 0, "end": segment.text.unicodeScalars.count, "text": "甲😀甲 + x"])
        let updated = try core.snapshot()
        XCTAssertGreaterThan(updated.operationCount, before)
        XCTAssertEqual(updated.notes[0].blocks.flatMap(\.segments).first { $0.id == segment.id }?.text, "甲😀甲 + x")
        XCTAssertTrue(updated.notes[0].pages.flatMap(\.objects).contains { $0.revisionId != nil })
        _ = try core.invoke("editRange", ["noteID": note.id, "segmentID": segment.id, "expectedText": "甲😀甲 + x", "start": 2, "end": 3, "text": "乙"])
        XCTAssertEqual(try core.snapshot().notes[0].blocks.flatMap(\.segments).first { $0.id == segment.id }?.text, "甲😀乙 + x")
        let reloaded = try NativeCore(deviceID: "another-mac")
        try reloaded.loadProject(core.projectJSON())
        XCTAssertEqual(try reloaded.snapshot().notes[0].blocks.flatMap(\.segments).first { $0.id == segment.id }?.text, "甲😀乙 + x")
    }
    @Test func testImportedConfirmedGlyphCreatesNativeHandwritingAndOfflineReadingPaths() throws {
        let fixture = try handwritingFixture(), core = try NativeCore(deviceID: "handwriting-mac")
        try core.loadProject(fixture)
        let before = try core.snapshot()
        XCTAssertEqual(before.operationCount, 6)
        XCTAssertEqual(before.notes[0].blocks[0].segments[0].text, "a")
        let original = try XCTUnwrap(before.notes[0].pages[0].objects.first { $0.id == "original-ink" })
        _ = try core.invoke("editRange", ["noteID": "ink-note", "segmentID": "ink-segment",
            "expectedText": "a", "start": 0, "end": 1, "text": "b"])
        let after = try core.snapshot()
        let correction = try XCTUnwrap(after.corrections.first)
        XCTAssertEqual(correction.mode, "handwriting")
        XCTAssertEqual(correction.after, "b")
        XCTAssertEqual(after.notes[0].blocks[0].segments[0].text, "b")
        let revision = try XCTUnwrap(after.notes[0].pages[0].objects.first { $0.revisionId == correction.id })
        XCTAssertEqual(revision.kind, "stroke")
        XCTAssertEqual(revision.replacesObjectIds, ["original-ink"])
        XCTAssertEqual(revision.points?.map(\.pressure), [0.25, 0.8])
        XCTAssertEqual(revision.points?.map(\.tiltX), [18, 18])
        XCTAssertEqual(revision.points?.map(\.time), [100, 145])
        XCTAssertEqual(revision.bounds.x, original.bounds.x)
        XCTAssertEqual(revision.bounds.y, original.bounds.y)
        XCTAssertFalse(after.notes[0].pages[0].objects.contains { $0.id == "original-ink" })
        let html = try JSONDecoder().decode(String.self, from: Data(core.invoke("readingHTML", ["noteID": "ink-note"]).utf8))
        XCTAssertTrue(html.contains("data-object-id=\"\(revision.id)\""))
        XCTAssertTrue(html.contains("data-replaces-object-ids=\"[&quot;original-ink&quot;]\""))
        XCTAssertTrue(html.contains("<line "))
        let exported = try core.projectJSON()
        XCTAssertTrue(exported.contains("handwriting.learn"))
        let reloaded = try NativeCore(deviceID: "handwriting-reader")
        try reloaded.loadProject(exported)
        let restored = try reloaded.snapshot()
        XCTAssertEqual(restored.corrections.first?.mode, "handwriting")
        XCTAssertEqual(restored.notes[0].pages[0].objects.first { $0.id == revision.id }?.points?.map(\.pressure), [0.25, 0.8])
        XCTAssertEqual(try reloaded.projectJSON(), exported)
    }
    @Test func testStaleEditAndFailedBatchLeaveAllOperationsUnchanged() throws {
        let core = try loaded()
        let note = try XCTUnwrap(core.snapshot().notes.first)
        let segment = try XCTUnwrap(note.blocks.flatMap(\.segments).first { $0.kind == "text" && $0.deleted != true })
        let before = try core.projectJSON()
        XCTAssertThrowsError(try core.invoke("editRange", ["noteID": note.id, "segmentID": segment.id, "expectedText": "旧版本", "start": 0, "end": 1, "text": "x"]))
        XCTAssertEqual(try core.projectJSON(), before)
        var staleCharacters = expectedCharacters(segment)
        staleCharacters[0]["id"] = "remote-reinserted-character"
        staleCharacters[0]["version"] = "remote-reinserted-version"
        XCTAssertThrowsError(try core.invoke("editRanges", ["noteID": note.id, "segmentID": segment.id,
            "expectedText": segment.text, "expectedResult": segment.text,
            "expectedCharacters": staleCharacters, "edits": []]))
        XCTAssertEqual(try core.projectJSON(), before)
        let edits: [[String: Any]] = [
            ["expectedText": segment.text, "start": 0, "end": 0, "text": "新增"],
            ["expectedText": "错误的中间版本", "start": 0, "end": 1, "text": "x"]
        ]
        XCTAssertThrowsError(try core.invoke("editRanges", ["noteID": note.id, "segmentID": segment.id, "expectedText": segment.text,
            "expectedCharacters": expectedCharacters(segment), "expectedResult": "x", "edits": edits]))
        XCTAssertEqual(try core.projectJSON(), before)
    }
    @Test func testConcreteBatchChecksFinalTextAndRollsBackUncapturedInput() throws {
        let core = try loaded()
        let note = try XCTUnwrap(core.snapshot().notes.first)
        let segment = try XCTUnwrap(note.blocks.flatMap(\.segments).first { $0.kind == "text" && $0.deleted != true })
        let before = try core.projectJSON()
        let edits: [[String: Any]] = [["expectedText": segment.text, "start": 0, "end": 0, "text": "甲😀"]]
        XCTAssertThrowsError(try core.invoke("editRanges", ["noteID": note.id, "segmentID": segment.id, "expectedText": segment.text,
            "expectedCharacters": expectedCharacters(segment), "expectedResult": "还有未捕获的输入", "edits": edits]))
        XCTAssertEqual(try core.projectJSON(), before)
        let expected = "甲😀" + segment.text
        _ = try core.invoke("editRanges", ["noteID": note.id, "segmentID": segment.id, "expectedText": segment.text,
            "expectedCharacters": expectedCharacters(segment), "expectedResult": expected, "edits": edits])
        XCTAssertEqual(try core.snapshot().notes[0].blocks.flatMap(\.segments).first { $0.id == segment.id }?.text, expected)
    }
    @Test func testReviewPersistsImmutableAssessmentAndSchedule() throws {
        let core = try loaded()
        let card = try XCTUnwrap(core.snapshot().reviewCards.first)
        _ = try core.invoke("review", ["blockID": card.blockId, "rating": true, "now": 1_792_600_000_000.0])
        let snapshot = try core.snapshot()
        let after = try XCTUnwrap(snapshot.reviewCards.first { $0.blockId == card.blockId })
        XCTAssertEqual(after.reviews, card.reviews + 1)
        XCTAssertEqual(after.history.last?.known, true)
        XCTAssertTrue(snapshot.settings.keys.contains { $0.hasPrefix("review-event:") })
        let second = try NativeCore(deviceID: "review-reader")
        try second.loadProject(core.projectJSON())
        XCTAssertEqual(try second.snapshot().reviewCards.first { $0.blockId == card.blockId }?.reviews, after.reviews)
    }
    @Test func testMergeAndOfflineReadingExportsUseSharedKernel() throws {
        let first = try loaded("mac-a"), second = try loaded("mac-b")
        let note = try XCTUnwrap(first.snapshot().notes.first)
        _ = try first.invoke("manageNote", ["noteID": note.id, "tags": ["原生验证"]])
        try second.mergeOperations(first.operationsJSON())
        XCTAssertEqual(try second.snapshot().notes.first?.tags, ["原生验证"])
        let html = try second.invoke("readingHTML", ["noteID": note.id])
        let htmlValue = try JSONDecoder().decode(String.self, from: Data(html.utf8))
        XCTAssertTrue(htmlValue.contains("Content-Security-Policy"))
        XCTAssertTrue(htmlValue.contains("原稿引用"))
        XCTAssertTrue(htmlValue.contains("<svg"))
        let markdown = try JSONDecoder().decode(String.self, from: Data(second.invoke("markdown", ["noteID": note.id]).utf8))
        XCTAssertTrue(markdown.contains(note.title))
    }
}

// These small assertions use Swift Testing, which is bundled with Command Line Tools.
// Keep the familiar assertion spelling across the HTTP/storage test suites.
private struct RequiredTestValue: Error {}
func XCTUnwrap<T>(_ value: @autoclosure () throws -> T?, _ message: String = "") throws -> T {
    if let value = try value() { return value }
    Issue.record("Required test value was nil. \(message)")
    throw RequiredTestValue()
}
func XCTAssertEqual<T: Equatable>(_ lhs: @autoclosure () throws -> T, _ rhs: @autoclosure () throws -> T, _ message: String = "") {
    do {
        let a = try lhs(), b = try rhs()
        if a != b { Issue.record("Expected equal values: \(a) and \(b). \(message)") }
    } catch { Issue.record("Unexpected error: \(error). \(message)") }
}
func XCTAssertGreaterThan<T: Comparable>(_ lhs: @autoclosure () throws -> T, _ rhs: @autoclosure () throws -> T, _ message: String = "") {
    do {
        let a = try lhs(), b = try rhs()
        if a <= b { Issue.record("Expected \(a) greater than \(b). \(message)") }
    } catch { Issue.record("Unexpected error: \(error). \(message)") }
}
func XCTAssertTrue(_ value: @autoclosure () throws -> Bool, _ message: String = "") {
    do { if try !value() { Issue.record("Expected true. \(message)") } }
    catch { Issue.record("Unexpected error: \(error). \(message)") }
}
func XCTAssertFalse(_ value: @autoclosure () throws -> Bool, _ message: String = "") {
    do { if try value() { Issue.record("Expected false. \(message)") } }
    catch { Issue.record("Unexpected error: \(error). \(message)") }
}
func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T, _ message: String = "") {
    do { _ = try expression(); Issue.record("Expected an error. \(message)") } catch { }
}
func XCTAssertNoThrow<T>(_ expression: @autoclosure () throws -> T, _ message: String = "") {
    do { _ = try expression() } catch { Issue.record("Unexpected error: \(error). \(message)") }
}
func XCTAssertNil<T>(_ expression: @autoclosure () throws -> T?, _ message: String = "") {
    do { if try expression() != nil { Issue.record("Expected nil. \(message)") } }
    catch { Issue.record("Unexpected error: \(error). \(message)") }
}
func XCTAssertNotNil<T>(_ expression: @autoclosure () throws -> T?, _ message: String = "") {
    do { if try expression() == nil { Issue.record("Expected a value. \(message)") } }
    catch { Issue.record("Unexpected error: \(error). \(message)") }
}
