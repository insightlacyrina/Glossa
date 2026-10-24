import Foundation
import Testing
@testable import GlossaCore

struct AIProxyTests {
    @Test func testSwiftCryptoKitObjectsInteroperateWithNodeProxyAndRevocation() async throws {
        let fixture = try NativeAIFixture()
        defer { fixture.stop() }
        let config = SyncConfiguration(url: fixture.url, token: "native-ai-token", projectID: "native-ai-project", mode: "e2ee", passphrase: "LONG-TERM-PASSPHRASE-MUST-STAY-LOCAL")
        let client = AIProxyClient()
        let status = try await client.status(configuration: config)
        #expect(status.aiProxyAvailable && status.aiTemporaryPlaintextAccess)
        let raw = ##"{"id":"object-native","pageId":"page-native","kind":"text","layerId":"ink","version":"android:1:original","bounds":{"x":1,"y":2,"width":300,"height":60},"text":"原稿😀 x² 保持不确定","color":"#333333"}"##
        let source = try JSONDecoder().decode(CorePaperObject.self, from: Data(raw.utf8))
        let selected = try AIProxyObject(source)
        let grant = try await client.createGrant(configuration: config, objects: [selected], ttlSeconds: 30, consent: true,
            expectedEndpoint: try #require(status.endpoint), expectedModel: try #require(status.model))
        let candidate = try await client.submit(configuration: config, grant: grant, objects: [selected], jobID: "native-job")
        #expect(candidate.objects.first?.text == source.text)
        #expect(candidate.objects.first?.id == source.id)
        #expect(candidate.objects.first?.uncertainty.isEmpty == false)
        let repeated = try await client.submit(configuration: config, grant: grant, objects: [selected], jobID: "native-job")
        #expect(repeated.objects.first?.text == source.text)
        let inspection = try fixture.command("inspect")
        #expect(inspection["calls"] as? Int == 1)
        let modelInput = try #require(inspection["input"] as? String)
        #expect(modelInput.contains(source.text ?? "missing"))
        #expect(!modelInput.contains(config.passphrase))
        #expect(!modelInput.contains("unselected-private-object"))
        let audit = try #require(inspection["audit"] as? String)
        #expect(!audit.contains(source.text ?? "missing"))
        #expect(!audit.contains("owner-model-key"))
        try await client.revoke(configuration: config, grantID: grant.grantId)
        let second = try await client.createGrant(configuration: config, objects: [selected], ttlSeconds: 30, consent: true,
            expectedEndpoint: try #require(status.endpoint), expectedModel: try #require(status.model))
        try await client.revoke(configuration: config, grantID: second.grantId)
        do {
            _ = try await client.submit(configuration: config, grant: second, objects: [selected], jobID: "must-not-run")
            Issue.record("Revoked native grant must not send any object payload")
        } catch let error as NativeSyncError { #expect(error.code == "GRANT_REVOKED") }
        #expect(try fixture.command("inspect")["calls"] as? Int == 1)
    }
}

private final class NativeAIFixture {
    private let process = Process(), input = Pipe(), output = Pipe()
    let url: String
    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let script = #"""
        import {createServer} from 'node:http';import {once} from 'node:events';import {createInterface} from 'node:readline';
        import {createAIProxy} from './server/ai-proxy.mjs';
        let calls=0,input='';
        const provider=createServer(async(q,r)=>{calls++;let raw='';for await(const p of q)raw+=p;input=raw;
          const objects=JSON.parse(JSON.parse(raw).messages[1].content).objects.map(o=>({id:o.id,version:o.version,text:o.text,uncertainty:['mock model; not independently verified']}));
          r.setHeader('content-type','application/json');r.end(JSON.stringify({choices:[{message:{content:JSON.stringify({objects})}}]}));});
        provider.listen(0,'127.0.0.1');await once(provider,'listening');
        const proxy=createAIProxy({enabled:true,endpoint:'http://127.0.0.1:'+provider.address().port+'/v1/chat/completions',model:'mock-native-model',apiKey:'owner-model-key'});
        const server=createServer((q,r)=>{void proxy.handle(q,r,{tokenAuthenticated:q.headers.authorization==='Bearer native-ai-token'});});
        server.listen(0,'127.0.0.1');await once(server,'listening');console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port}));
        const lines=createInterface({input:process.stdin});lines.on('line',async line=>{
          if(line==='inspect')console.log(JSON.stringify({calls,input,audit:JSON.stringify(proxy.audit())}));
          if(line==='stop'){proxy.close();server.closeAllConnections();provider.closeAllConnections();server.close();provider.close();process.exit(0);}
        });
        process.on('SIGTERM',()=>{proxy.close();server.closeAllConnections();provider.closeAllConnections();process.exit(0);});
        """#
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--input-type=module", "-e", script]
        process.currentDirectoryURL = root
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.standardError
        try process.run()
        guard let url = try Self.line(output.fileHandleForReading)["url"] as? String else { process.terminate(); throw NativeSyncError("AI_FIXTURE", "Native AI test fixture could not start") }
        self.url = url
    }
    func command(_ value: String) throws -> [String: Any] {
        try input.fileHandleForWriting.write(contentsOf: Data((value + "\n").utf8))
        return try Self.line(output.fileHandleForReading)
    }
    func stop() {
        if process.isRunning { try? input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8)); process.waitUntilExit() }
    }
    private static func line(_ handle: FileHandle) throws -> [String: Any] {
        var data = Data()
        while let value = try handle.read(upToCount: 1), !value.isEmpty { if value.first == 10 { break }; data.append(value) }
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
