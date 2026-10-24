import Testing
import Foundation
@testable import GlossaCore

struct SyncTests {
    private let token = "native-integration-token-with-enough-entropy"

    @Test func testTransportValidationRejectsRemoteHTTPAndCredentials() throws {
        for url in ["http://example.invalid", "https://user:password@example.invalid", "file:///tmp", "https://localhost/#fragment"] {
            #expect(throws: (any Error).self) { try NativeSyncClient.validatedURL(SyncConfiguration(url: url, token: token, projectID: "transport")) }
        }
        for url in ["http://127.0.0.1:8787", "http://localhost:8787", "https://example.invalid"] {
            _ = try NativeSyncClient.validatedURL(SyncConfiguration(url: url, token: token, projectID: "transport"))
        }
    }

    @Test func testEncryptedAuthenticationBindsProjectIdentityAndRejectsTampering() throws {
        let config = SyncConfiguration(url: "http://localhost", token: token, projectID: "crypto", mode: "e2ee", passphrase: "twelve-or-more-characters")
        let codec = try SyncCodec(configuration: config)
        let op: [String: Any] = ["id": "operation-1", "text": "原稿🙂", "nested": ["A": true, "中": 2]]
        let envelope = try #require(try JSONSerialization.jsonObject(with: Data(codec.encode(op).utf8)) as? [String: Any])
        #expect(try codec.canonical(codec.decode(envelope)) == codec.canonical(op))
        var damaged = envelope
        damaged["fingerprint"] = String(repeating: "0", count: 64)
        #expect(throws: (any Error).self) { try codec.decode(damaged) }
        damaged = envelope; damaged["id"] = "operation-2"
        #expect(throws: (any Error).self) { try codec.decode(damaged) }
        let wrong = try SyncCodec(configuration: SyncConfiguration(url: config.url, token: token, projectID: "other-project", mode: "e2ee", passphrase: config.passphrase))
        #expect(throws: (any Error).self) { try wrong.decode(envelope) }
    }

    @Test func testPlainHTTPInteropPaginationBisectionAndServerRestore() async throws {
        try await runInterop(mode: "plain")
    }

    @Test func testEncryptedHTTPInteropPaginationBisectionAndServerRestore() async throws {
        try await runInterop(mode: "e2ee")
    }

    private func runInterop(mode: String) async throws {
        let fixture = try SyncFixture(mode: mode, token: token)
        defer { fixture.stop() }
        let config = SyncConfiguration(url: fixture.url, token: token, projectID: "native-interop-" + mode,
                                       mode: mode, passphrase: "interop-passphrase-123456")
        // The first operation is pre-written by src/sync.ts. Re-encoding it must
        // remain idempotent across Swift/JS, including JS numeric/key formatting.
        var operations: [[String: Any]] = [["id": "seed-op", "text": "原稿🙂", "numbers": [1e-7, 1e21, -0.0],
                                          "keys": ["2": 2, "10": 10, "A": 1, "a": 2, "中": 3, "😀": 4, "\u{E000}": 5]]]
        for i in 0..<11 { operations.append(["id": "swift-\(i)", "text": String(repeating: "纸", count: 130 + i % 3 * 10), "pressure": Double(i) / 11]) }
        let allJSON = String(decoding: try JSONSerialization.data(withJSONObject: operations), as: UTF8.self)
        let client = NativeSyncClient()
        let first = try await client.synchronize(configuration: config, operationsJSON: allJSON, cursor: 0, acknowledgedIDs: [], generation: nil)
        let firstOps = try #require(try JSONSerialization.jsonObject(with: Data(first.operationsJSON.utf8)) as? [[String: Any]])
        #expect(Set(firstOps.compactMap { $0["id"] as? String }) == Set(operations.compactMap { $0["id"] as? String }))
        #expect(first.acknowledgedIDs.count == 12)
        let inspection = try fixture.command("inspect")
        #expect(inspection["count"] as? Int == 12)
        #expect((inspection["rejections"] as? Int ?? 0) > 0, "413 must cause safe batch bisection")
        #expect((inspection["pages"] as? Int ?? 0) > 1)
        #expect(inspection["decoded"] as? Bool == true, "TypeScript must decrypt every Swift envelope")
        let second = try await client.synchronize(configuration: config, operationsJSON: allJSON, cursor: first.cursor,
                                                  acknowledgedIDs: first.acknowledgedIDs, generation: first.generation)
        #expect(second.operationsJSON == "[]")
        #expect(second.acknowledgedIDs.count == 12)
        let rewind = try await client.synchronize(configuration: config, operationsJSON: allJSON, cursor: first.cursor + 100,
                                                  acknowledgedIDs: first.acknowledgedIDs, generation: first.generation)
        #expect(rewind.cursor == first.cursor, "An ahead cursor must trigger a full safe replay")
        #expect(rewind.acknowledgedIDs.count == 12)
        let denied = SyncConfiguration(url: config.url, token: "incorrect-test-token", projectID: config.projectID,
                                       mode: mode, passphrase: config.passphrase)
        do {
            _ = try await client.synchronize(configuration: denied, operationsJSON: allJSON, cursor: 0, acknowledgedIDs: [], generation: nil)
            Issue.record("Invalid bearer token must be rejected")
        } catch let error as NativeSyncError { #expect(error.code == "UNAUTHORIZED") }
        _ = try fixture.command("restore")
        let restored = try await client.synchronize(configuration: config, operationsJSON: allJSON, cursor: second.cursor,
                                                    acknowledgedIDs: second.acknowledgedIDs, generation: second.generation)
        #expect(restored.generation != first.generation)
        #expect(try fixture.command("inspect")["count"] as? Int == 12)
        #expect(restored.acknowledgedIDs.count == 12)
        // Same-ID/different-content fails instead of silently replacing the archive.
        let collision = "[{\"id\":\"seed-op\",\"text\":\"changed\"}]"
        do {
            _ = try await client.synchronize(configuration: config, operationsJSON: collision, cursor: 0, acknowledgedIDs: [], generation: nil)
            Issue.record("Identity collision must stop synchronization")
        } catch let error as NativeSyncError { #expect(error.code == "OP_ID_COLLISION") }
        #expect(try fixture.command("inspect")["count"] as? Int == 12)
    }
}

/// Runs the repository's real SQLite HTTP service and browser crypto codec.
/// Isolated temp storage is removed by the child on shutdown.
private final class SyncFixture {
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    let url: String
    init(mode: String, token: String) throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        if let repository = ProcessInfo.processInfo.environment["GLOSSA_REPOSITORY"] {
            root = URL(fileURLWithPath: repository)
        }
        let script = #"""
        import {createSyncServer} from './server/app.mjs';
        import {encodeOperation, decodeOperation} from './src/sync.ts';
        import {mkdtemp, rm} from 'node:fs/promises';
        import {tmpdir} from 'node:os';
        import {join} from 'node:path';
        import {once} from 'node:events';
        import {createInterface} from 'node:readline';
        const mode=process.env.GLOSSA_TEST_MODE, token=process.env.GLOSSA_TEST_TOKEN;
        const dir=await mkdtemp(join(tmpdir(),'glossa-native-sync-'));
        let app, port=0, pages=0, rejections=0;
        async function start(){
          app=createSyncServer({dataDir:dir,token,maxBodyBytes:1600,maxPullBytes:1250});
          app.server.on('request',(_q,r)=>r.on('finish',()=>{if(r.statusCode===413) rejections++;if(r.statusCode===200)pages++;}));
          app.server.listen(port,'127.0.0.1');await once(app.server,'listening');port=app.server.address().port;
        }
        await start();
        const url='http://127.0.0.1:'+port;
        const config={url,token,projectId:'native-interop-'+mode,mode,passphrase:'interop-passphrase-123456'};
        const seed={id:'seed-op',text:'原稿🙂',numbers:[1e-7,1e21,-0],keys:{'2':2,'10':10,A:1,a:2,中:3,'😀':4,'\uE000':5}};
        const envelope=await encodeOperation(config,seed);
        // Derivation is exported only through the regular transport, which locks
        // the same key ID that the native client will later present.
        const {syncOperations}=await import('./src/sync.ts');
        await syncOperations(config,[seed]);
        console.log(JSON.stringify({url}));
        const lines=createInterface({input:process.stdin});
        lines.on('line',async line=>{
          try {
            if(line==='inspect'){
              const rows=app.db.prepare('SELECT envelope FROM operations').all();
              for(const row of rows)await decodeOperation(config,JSON.parse(row.envelope));
              console.log(JSON.stringify({count:rows.length,decoded:true,pages,rejections}));
            }else if(line==='restore'){
              app.db.prepare("DELETE FROM operations WHERE id!='seed-op'").run();
              await app.close();await start();console.log(JSON.stringify({ok:true}));
            }else if(line==='stop'){
              await app.close();await rm(dir,{recursive:true,force:true});process.exit(0);
            }
          }catch(error){console.log(JSON.stringify({error:String(error)}));}
        });
        process.on('SIGTERM',async()=>{await app.close();await rm(dir,{recursive:true,force:true});process.exit(0)});
        """#
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--import", "tsx", "--input-type=module", "-e", script]
        process.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["GLOSSA_TEST_MODE"] = mode; env["GLOSSA_TEST_TOKEN"] = token
        process.environment = env
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.standardError
        try process.run()
        guard let ready = try Self.readLine(output.fileHandleForReading)["url"] as? String else {
            process.terminate(); throw NativeSyncError("FIXTURE_FAILED", "HTTP test fixture could not start")
        }
        url = ready
    }
    func command(_ command: String) throws -> [String: Any] {
        try input.fileHandleForWriting.write(contentsOf: Data((command + "\n").utf8))
        let result = try Self.readLine(output.fileHandleForReading)
        if let error = result["error"] as? String { throw NativeSyncError("FIXTURE_FAILED", error) }
        return result
    }
    func stop() {
        if process.isRunning {
            try? input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
            process.waitUntilExit()
        }
    }
    private static func readLine(_ handle: FileHandle) throws -> [String: Any] {
        var bytes = Data()
        while let next = try handle.read(upToCount: 1), !next.isEmpty {
            if next.first == 10 { break }; bytes.append(next)
        }
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw NativeSyncError("FIXTURE_FAILED", "HTTP fixture output was invalid") }
        return object
    }
}
