/** Incremental macOS integration: real Chrome contexts, isolated Node process and SQLite backup.
 * Runs production domain/storage/sync modules; it does not claim physical mobile-device or WAN QA.
 * CHROMIUM_PATH=/path/to/chrome node scripts/verify-local-sync.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { once } from 'node:events';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const root = resolve('.');
const output = resolve(process.env.GLOSSA_LOCAL_SYNC_OUTPUT || 'artifacts/local-migration/sync');
await mkdir(output, { recursive: true });
const run = join(output, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(run);
const token = randomBytes(32).toString('hex');
const results = [];
const vite = await createServer({
  configFile: false,
  plugins: [
    {
      name: 'local-sync-harness',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/__local_sync') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><title>Glossa local sync integration</title>');
          } else next();
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
let browser;
let server;

async function startServer(dataDir, port = 0) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {createSyncServer} from ${JSON.stringify(join(root, 'server/app.mjs'))};
    const app=createSyncServer({dataDir:process.env.GLOSSA_DATA,token:process.env.GLOSSA_TOKEN,allowedOrigins:[process.env.GLOSSA_TEST_ORIGIN]});
    app.server.listen(Number(process.env.GLOSSA_TEST_PORT),'127.0.0.1',()=>process.send({port:app.server.address().port,pid:process.pid}));
    process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));
  `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GLOSSA_DATA: dataDir,
        GLOSSA_TOKEN: token,
        GLOSSA_TEST_ORIGIN: origin,
        GLOSSA_TEST_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let error = '';
  child.stderr.on('data', (x) => {
    error += x;
  });
  const ready = await Promise.race([
    once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(([code]) => {
      throw new Error(`Sync server exited ${code}: ${error}`);
    }),
  ]);
  return { child, ...ready, url: `http://127.0.0.1:${ready.port}` };
}
async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill('SIGTERM');
  await once(instance.child, 'exit');
}
async function init(page, { project, device, role, config, recover = false }) {
  await page.goto(origin + '/__local_sync');
  return page.evaluate(
    async ({ project, device, role, config, recover }) => {
      const { NotebookEngine } = await import('/src/domain.ts');
      const { startAutoSync } = await import('/src/sync.ts');
      const { readLocal, writeLocal, saveWorkspace } = await import('/src/storage.ts');
      const stored = recover ? await readLocal('current') : undefined;
      const engine = new NotebookEngine(stored?.project || project, device, role);
      let cursor = stored?.cursor || 0;
      const save = () => saveWorkspace({ project: engine.project, cursor, epoch: 'legacy' });
      if (!stored) await writeLocal('current', { project: engine.project, cursor });
      const statuses = [];
      const sync = startAutoSync({
        config,
        intervalMs: 60_000,
        getOperations: () => engine.project.operations,
        getCursor: () => cursor,
        applyRemote: async (operations) => {
          engine.merge({ ...engine.project, operations });
          await save();
        },
        setCursor: async (next) => {
          cursor = next;
          await save();
        },
        getAcknowledgedIds: (identity) => readLocal('sync-ack:' + identity).then((x) => x || []),
        setAcknowledgedIds: (identity, ids) => writeLocal('sync-ack:' + identity, ids),
        onStatus: (status, error) => statuses.push({ status, error }),
      });
      window.localSync = { engine, sync, save, statuses, config };
      await sync.syncNow();
      return { project: engine.project, statuses };
    },
    { project, device, role, config, recover },
  );
}
async function syncNow(page) {
  await page.evaluate(() => window.localSync.sync.syncNow());
}
async function snapshot(page) {
  return page.evaluate(() => ({
    project: window.localSync.engine.project,
    state: window.localSync.engine.state,
    statuses: window.localSync.statuses,
  }));
}
function pass(mode, message) {
  console.log(`PASS ${mode}: ${message}`);
}

try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  for (const mode of ['plain', 'e2ee']) {
    const dir = join(run, mode);
    await mkdir(dir);
    server = await startServer(join(dir, 'server'));
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const errors = [];
    pageA.on('pageerror', (e) => errors.push(e.message));
    pageB.on('pageerror', (e) => errors.push(e.message));
    await pageA.goto(origin + '/__local_sync');
    const seed = await pageA.evaluate(async () => {
      const { NotebookEngine } = await import('/src/domain.ts');
      const { openNative, renameNative, createNativeLink } = await import('/src/formats.ts');
      const e = new NotebookEngine(undefined, 'mac-browser-tablet-role', 'tablet');
      const noteId = e.createNote('本机同步增量验收');
      const pageId = e.getNote(noteId).pages[0].id;
      const points = [
        { x: 12, y: 20, pressure: 0.22, tiltX: -13, tiltY: 9, time: 10 },
        { x: 22, y: 24, pressure: 0.78, tiltX: -9, tiltY: 7, time: 20 },
      ];
      const strokeId = e.addStroke(noteId, pageId, points);
      const objectId = e.addText(
        noteId,
        pageId,
        'a+b=c',
        { x: 80, y: 100, width: 260, height: 40 },
        'formula',
      );
      const blockId = e.createBlock(noteId, '合并', [objectId]);
      const segmentId = e.recognize(noteId, blockId, [objectId], 'a+b=c', {
        kind: 'formula',
        deterministic: true,
      });
      const document = renameNative(
        openNative('本机同步-旧.md', '# 本机同步\n\na+b=c\n'),
        '本机同步.md',
      );
      const nativeObject = document.objects.find((o) => o.text.includes('a+b=c'));
      const link = createNativeLink(document, nativeObject.id);
      e.setSetting('source:' + link.id, {
        document,
        link,
        paperObjectId: objectId,
        noteId,
        pageId,
        ownerDeviceId: 'mac-browser-tablet-role',
        uri: 'content://local-sync-fixture/source.md',
      });
      return { project: e.project, noteId, pageId, strokeId, points, segmentId };
    });
    const config = {
      url: server.url,
      token,
      projectId: seed.project.id,
      mode,
      ...(mode === 'e2ee' ? { passphrase: 'local-only-browser-integration-secret' } : {}),
    };
    await init(pageA, {
      project: seed.project,
      role: 'tablet',
      device: 'mac-browser-tablet-role',
      config,
    });
    const empty = { schemaVersion: 1, id: seed.project.id, metadata: {}, operations: [] };
    await init(pageB, { project: empty, role: 'mac', device: 'mac-browser-reader-role', config });
    assert.deepEqual((await snapshot(pageB)).state.notes, (await snapshot(pageA)).state.notes);
    assert.deepEqual(
      (await snapshot(pageB)).state.settings,
      (await snapshot(pageA)).state.settings,
    );
    const nativeSource = Object.values((await snapshot(pageB)).state.settings).find(
      (x) => x?.document && x?.link,
    );
    assert.equal(nativeSource.document.history.length, 1);
    assert.deepEqual(nativeSource.link.sourceSnapshot, nativeSource.document);
    pass(
      mode,
      'two isolated Chrome contexts received A, B and complete source snapshot through separate Node server',
    );
    const db = new DatabaseSync(join(dir, 'server', 'quiet-paper.sqlite'), { readOnly: true });
    const oldBackup = join(dir, 'before-offline.sqlite');
    await backup(db, oldBackup);
    db.close();
    await Promise.all([ctxA.setOffline(true), ctxB.setOffline(true)]);
    await pageA.evaluate(async (seed) => {
      const { engine: e, save } = window.localSync;
      e.editSegment(seed.noteId, seed.segmentId, 'x+b=c');
      e.addStroke(seed.noteId, seed.pageId, [
        { x: 60, y: 70, pressure: 0.5, tiltX: 4, tiltY: -8, time: 30 },
        { x: 65, y: 72, pressure: 0.9, tiltX: 5, tiltY: -7, time: 40 },
      ]);
      await save();
    }, seed);
    await pageB.evaluate(async (seed) => {
      window.localSync.engine.editSegment(seed.noteId, seed.segmentId, 'a+b=z');
      await window.localSync.save();
    }, seed);
    await Promise.all([syncNow(pageA), syncNow(pageB)]);
    assert.equal((await snapshot(pageA)).statuses.at(-1).status, 'offline');
    assert.equal((await snapshot(pageB)).statuses.at(-1).status, 'offline');
    const beforeReload = await snapshot(pageB);
    await ctxB.setOffline(false);
    await init(pageB, {
      project: empty,
      role: 'mac',
      device: 'mac-browser-reader-role',
      config,
      recover: true,
    });
    assert.equal(
      (await snapshot(pageB)).project.operations.length >= beforeReload.project.operations.length,
      true,
    );
    await ctxA.setOffline(false);
    await syncNow(pageA);
    await syncNow(pageB);
    await syncNow(pageA);
    const a = await snapshot(pageA),
      b = await snapshot(pageB);
    assert.deepEqual(a.state, b.state);
    assert.equal(a.state.notes[0].blocks[0].segments[0].text, 'x+b=z');
    assert.equal(a.state.conflicts.length, 0);
    assert.deepEqual(
      a.state.notes[0].pages[0].objects.find((x) => x.id === seed.strokeId).points,
      seed.points,
    );
    assert.equal(a.state.notes[0].pages[0].objects.filter((x) => x.kind === 'stroke').length, 2);
    pass(
      mode,
      'offline edits survived IndexedDB reload; reconnect merged disjoint B characters and preserved both raw A strokes',
    );
    const archive = new DatabaseSync(join(dir, 'server', 'quiet-paper.sqlite'), { readOnly: true });
    const envelopes = archive
      .prepare('SELECT envelope FROM operations ORDER BY seq')
      .all()
      .map((x) => JSON.parse(x.envelope));
    if (mode === 'e2ee')
      assert.ok(
        envelopes.every(
          (x) => x.mode === 'e2ee' && !('payload' in x) && !JSON.stringify(x).includes('本机同步'),
        ),
      );
    else assert.ok(envelopes.every((x) => x.mode === 'plain' && x.payload));
    const finalBackup = join(dir, 'complete.sqlite');
    await backup(archive, finalBackup);
    archive.close();
    const originalPid = server.pid,
      originalPort = server.port;
    await stopServer(server);
    server = undefined;
    const restoredDir = join(dir, 'restored-old');
    await mkdir(restoredDir);
    await copyFile(oldBackup, join(restoredDir, 'quiet-paper.sqlite'));
    server = await startServer(restoredDir, originalPort);
    assert.notEqual(server.pid, originalPid);
    // Same service identity after restore is required to exercise persisted generation acknowledgements.
    const restoredConfig = { ...config, url: server.url };
    await init(pageA, {
      project: empty,
      role: 'tablet',
      device: 'mac-browser-tablet-role',
      config: restoredConfig,
      recover: true,
    });
    await init(pageB, {
      project: empty,
      role: 'mac',
      device: 'mac-browser-reader-role',
      config: restoredConfig,
      recover: true,
    });
    await syncNow(pageA);
    await syncNow(pageB);
    await syncNow(pageA);
    assert.deepEqual((await snapshot(pageA)).state, a.state);
    assert.deepEqual((await snapshot(pageB)).state, a.state);
    // A new client, with no local history, must reconstruct everything from the repaired archive.
    const ctxFresh = await browser.newContext();
    const pageFresh = await ctxFresh.newPage();
    await init(pageFresh, {
      project: empty,
      role: 'mac',
      device: 'mac-browser-recovered',
      config: restoredConfig,
    });
    const recovered = await snapshot(pageFresh);
    assert.deepEqual(recovered.state, a.state);
    assert.deepEqual(
      new Set(recovered.project.operations.map((x) => x.id)),
      new Set(a.project.operations.map((x) => x.id)),
    );
    assert.equal(errors.length, 0);
    pass(
      mode,
      'new server process restored older SQLite snapshot, clients repaired archive; fresh Chrome context reconstructed complete A/B/history',
    );
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify(
        {
          mode,
          status: 'passed',
          originalPid,
          restoredPid: server.pid,
          operationCount: a.project.operations.length,
          rawStrokeCount: 2,
          sourceFixture:
            'Production NativeDocument/NativeLink/SourceRecord with rename history, not a React source-coordinator workflow',
          pageErrors: errors,
          transport: 'localhost HTTP',
          clients:
            'actual isolated Chrome contexts using production modules; roles assigned by test',
          excluded: [
            'physical mobile devices',
            'LAN',
            'WAN',
            'UI settings workflow',
            'physical stylus',
          ],
          cryptoArchiveCheck:
            mode === 'e2ee'
              ? 'ciphertext envelopes without plaintext payload'
              : 'plain operation payloads',
        },
        null,
        2,
      ),
    );
    results.push({ mode, passed: true, directory: dir });
    await ctxFresh.close();
    await ctxA.close();
    await ctxB.close();
    await stopServer(server);
    server = undefined;
  }
  await writeFile(
    join(run, 'summary.json'),
    JSON.stringify(
      {
        host: process.platform + '/' + process.arch,
        results,
        note: 'incremental local browser/module integration; not physical mobile or external network verification',
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${run}`);
} finally {
  await stopServer(server);
  await browser?.close();
  await vite.close();
}
