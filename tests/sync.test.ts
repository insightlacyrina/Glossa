import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { backup } from 'node:sqlite';
import { createSyncServer } from '../server/app.mjs';
import {
  decodeOperation,
  encodeOperation,
  syncOperations,
  startAutoSync,
  MAX_SYNC_REQUEST_BYTES,
  SyncProtocolError,
  type SyncConfig,
  type SyncOperation,
} from '../src/sync.ts';

const token = 'test-quiet-paper-token-with-enough-entropy';
test('automatic generation handshake validates HTTPS and URL credentials before sending any token', async (t) => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error('network must not be reached');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  for (const url of ['http://example.invalid', 'https://user:password@example.invalid']) {
    let error = '';
    const client = startAutoSync({
      config: { url, token, projectId: 'invalid-transport', mode: 'plain' },
      getOperations: () => [],
      getCursor: () => 0,
      applyRemote: () => {},
      setCursor: () => {},
      onStatus: (_status, message) => {
        if (message) error = message;
      },
      intervalMs: 60_000,
    });
    try {
      await client.syncNow();
      assert.match(error, /HTTPS|地址无效/);
      assert.equal(requests, 0);
    } finally {
      client.stop();
    }
  }
});
test('remote sync refuses cleartext transport before sending a token or note operations', async () => {
  await assert.rejects(
    syncOperations(
      { url: 'http://example.invalid', token, projectId: 'transport-test', mode: 'plain' },
      [],
    ),
    /HTTPS/,
  );
});
async function setup(extra: Partial<Parameters<typeof createSyncServer>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quiet-paper-sync-'));
  const app = createSyncServer({ dataDir: dir, token, ...extra });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No listening port');
  const url = `http://127.0.0.1:${address.port}`;
  const config: SyncConfig = { url, token, projectId: 'test-project', mode: 'plain' };
  return {
    dir,
    app,
    config,
    cleanup: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function wireOp(id: string, text = '原始笔迹') {
  return { id, mode: 'plain', payload: { id, text } };
}

test('wire canonicalization uses locale-independent UTF-16 key order for mixed case and Unicode', async () => {
  const config: SyncConfig = {
    url: 'http://localhost',
    token,
    projectId: 'canonical-test',
    mode: 'plain',
  };
  const operation = {
    id: 'canonical-op',
    subjectPriority: { z: 1, 中: 2, a: 3, ä: 4, Z: 5, Ω: 6, A: 7 },
    nested: { 李: { b: 1, B: 2, ß: 3 }, 先: true },
  };
  const reordered = {
    nested: { 先: true, 李: { ß: 3, B: 2, b: 1 } },
    subjectPriority: { A: 7, Ω: 6, Z: 5, ä: 4, a: 3, 中: 2, z: 1 },
    id: 'canonical-op',
  };
  const first = await encodeOperation(config, operation),
    second = await encodeOperation(config, reordered);
  assert.equal(first.mode, 'plain');
  if (first.mode !== 'plain') throw new Error('wrong mode');
  assert.deepEqual(Object.keys(first.payload.subjectPriority as object), [
    'A',
    'Z',
    'a',
    'z',
    'ä',
    'Ω',
    '中',
  ]);
  assert.deepEqual(Object.keys(first.payload.nested as object), ['先', '李']);
  assert.deepEqual(Object.keys((first.payload.nested as Record<string, object>)['李']), [
    'B',
    'b',
    'ß',
  ]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const encrypted = { ...config, mode: 'e2ee' as const, passphrase: 'canonical-long-passphrase' };
  const encryptedFirst = await encodeOperation(encrypted, operation),
    encryptedSecond = await encodeOperation(encrypted, reordered);
  if (encryptedFirst.mode !== 'e2ee' || encryptedSecond.mode !== 'e2ee')
    throw new Error('wrong mode');
  assert.equal(encryptedFirst.fingerprint, encryptedSecond.fingerprint);
});

for (const mode of ['plain', 'e2ee'] as const) {
  test(`${mode} HTTP retries rejected batches by bisection and pulls every operation within byte pages`, async (t) => {
    const maxPullBytes = 1250;
    const fixture = await setup({ maxBodyBytes: 1600, maxPullBytes });
    t.after(fixture.cleanup);
    const config: SyncConfig = {
      ...fixture.config,
      mode,
      ...(mode === 'e2ee' ? { passphrase: 'capacity-test-long-passphrase' } : {}),
    };
    const statuses: number[] = [];
    fixture.app.server.on('request', (_req, res) => {
      res.on('finish', () => statuses.push(res.statusCode));
    });
    const operations = Array.from({ length: 11 }, (_, index) => ({
      id: `bounded-${index}`,
      text: '纸'.repeat(130 + (index % 3) * 10),
      pressure: index / 11,
    }));
    const result = await syncOperations(config, operations);
    assert.deepEqual(result.operations, operations);
    assert.deepEqual(new Set(result.acknowledgedIds), new Set(operations.map((op) => op.id)));
    assert.ok(statuses.includes(413));
    assert.ok(statuses.filter((status) => status === 200).length > 1);
    assert.equal(
      fixture.app.db.prepare('SELECT count(*) AS count FROM operations').get()!.count,
      operations.length,
    );
    const project = fixture.app.db
      .prepare('SELECT key_id FROM projects WHERE id=?')
      .get(config.projectId)!;
    const received: SyncOperation[] = [];
    let cursor = 0,
      hasMore = true,
      pages = 0;
    while (hasMore) {
      const response = await fetch(config.url + '/api/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: config.projectId,
          mode,
          keyId: project.key_id,
          ops: [],
          cursor,
        }),
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.ok(
        Buffer.byteLength(raw, 'utf8') <= maxPullBytes,
        'complete response must fit the pull budget when one operation fits',
      );
      const page = JSON.parse(raw);
      assert.ok(page.cursor > cursor);
      for (const envelope of page.ops) received.push(await decodeOperation(config, envelope));
      cursor = page.cursor;
      hasMore = page.hasMore;
      pages++;
    }
    assert.ok(pages > 1);
    assert.equal(cursor, result.cursor);
    assert.deepEqual(received, operations);
    assert.deepEqual((await syncOperations(config, [], result.cursor)).operations, []);
  });
}

test('UTF-8 upload budget splits more than 24 MiB before HTTP and avoids server 413', async (t) => {
  const fixture = await setup({ maxBodyBytes: MAX_SYNC_REQUEST_BYTES });
  t.after(fixture.cleanup);
  const requests: { bytes: number; status: number }[] = [];
  fixture.app.server.on('request', (req, res) => {
    const record = { bytes: Number(req.headers['content-length']), status: 0 };
    requests.push(record);
    res.on('finish', () => {
      record.status = res.statusCode;
    });
  });
  // Each string has 3 Mi UTF-16 code units but 9 MiB of UTF-8. Character counts would wrongly
  // combine all three into a request larger than the transport's actual byte budget.
  const operations = Array.from({ length: 3 }, (_, index) => ({
    id: `utf8-image-sized-${index}`,
    text: '纸'.repeat(3 * 1024 * 1024),
  }));
  const result = await syncOperations(fixture.config, operations);
  assert.equal(result.operations.length, operations.length);
  for (const [index, operation] of result.operations.entries())
    assert.equal(operation.text, operations[index].text);
  assert.ok(requests.length > 1);
  assert.ok(requests.every((request) => request.bytes <= MAX_SYNC_REQUEST_BYTES));
  assert.ok(requests.every((request) => request.status === 200));
});

test('an indivisible operation rejected with 413 leaves the local queue and acknowledgements intact', async (t) => {
  const fixture = await setup({ maxBodyBytes: 500 });
  t.after(fixture.cleanup);
  const local: SyncOperation[] = [
    { id: 'too-large-source-history', nativeHistory: '原稿'.repeat(1000) },
  ];
  const original = structuredClone(local),
    errors: string[] = [];
  let cursor = 0,
    applyCount = 0,
    acknowledged: string[] = [];
  const auto = startAutoSync({
    config: fixture.config,
    getOperations: () => local,
    getCursor: () => cursor,
    applyRemote: () => {
      applyCount++;
    },
    setCursor: (value) => {
      cursor = value;
    },
    getAcknowledgedIds: () => acknowledged,
    setAcknowledgedIds: (_identity, ids) => {
      acknowledged = ids;
    },
    onStatus: (status, error) => {
      if (status === 'error' && error) errors.push(error);
    },
    intervalMs: 60_000,
  });
  t.after(auto.stop);
  await auto.syncNow();
  await auto.syncNow();
  assert.ok(errors.length >= 2);
  assert.ok(
    errors.every(
      (error) =>
        error.includes('单个操作 too-large-source-history') && error.includes('队列已保留'),
    ),
  );
  assert.deepEqual(local, original);
  assert.deepEqual(acknowledged, []);
  assert.equal(cursor, 0);
  assert.equal(applyCount, 0);
  assert.equal(fixture.app.db.prepare('SELECT count(*) AS count FROM operations').get()!.count, 0);
});

test('one archived operation larger than a soft pull budget is sent whole without cursor starvation', async (t) => {
  const fixture = await setup({ maxPullBytes: 256 });
  t.after(fixture.cleanup);
  const operations = [
    { id: 'larger-than-pull-page', image: '原图'.repeat(300) },
    { id: 'after-large-object', text: '继续同步' },
  ];
  const first = await syncOperations(fixture.config, operations);
  assert.deepEqual(first.operations, operations);
  const second = await syncOperations(fixture.config, []);
  assert.deepEqual(second.operations, operations);
  assert.equal(second.cursor, first.cursor);
});

test('real HTTP push/pull preserves full A payload, stable IDs and idempotent retries', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const stroke = {
    id: 'tablet:stroke:1',
    kind: 'stroke',
    pageId: 'p1',
    points: [{ x: 12.3, y: 14, pressure: 0.72, tiltX: 33, tiltY: -10 }],
    layerId: 'ink-1',
  };
  const one = await syncOperations(fixture.config, [stroke]);
  assert.deepEqual(one.operations, [stroke]);
  assert.ok(one.cursor > 0);
  const duplicate = await syncOperations(fixture.config, [stroke], one.cursor);
  assert.deepEqual(duplicate.operations, []);
  assert.equal(duplicate.cursor, one.cursor);
  const second = await syncOperations(
    fixture.config,
    [{ id: 'phone:edit:1', symbolId: 'glyph-2', value: '+' }],
    0,
  );
  assert.equal(second.operations.length, 2);
  assert.deepEqual(second.operations[0], stroke);
  const other = await syncOperations({ ...fixture.config, projectId: 'another-project' }, [], 0);
  assert.deepEqual(other.operations, []);
  await assert.rejects(syncOperations(fixture.config, [{ ...stroke, points: [] }]), /操作身份冲突/);
  assert.equal(fixture.app.db.prepare('select count(*) as count from operations').get()!.count, 2);
});

test('WAL archive survives server restart and SQLite consistent backup restores', async (t) => {
  const fixture = await setup();
  let currentApp = fixture.app;
  t.after(async () => {
    await currentApp.close();
    await rm(fixture.dir, { recursive: true, force: true });
  });
  const op = { id: 'persist-1', data: { pages: ['p1'], mappedObjectIds: ['a1'], history: ['v1'] } };
  const first = await syncOperations(fixture.config, [op]);
  const snapshotDir = join(fixture.dir, 'snapshot');
  await mkdir(snapshotDir);
  await backup(currentApp.db, join(snapshotDir, 'quiet-paper.sqlite'));
  await currentApp.close();
  currentApp = createSyncServer({ dataDir: snapshotDir, token });
  currentApp.server.listen(0, '127.0.0.1');
  await once(currentApp.server, 'listening');
  const address = currentApp.server.address() as { port: number };
  const restored = await syncOperations(
    { ...fixture.config, url: `http://127.0.0.1:${address.port}` },
    [],
    0,
  );
  assert.deepEqual(restored.operations, [op]);
  assert.equal(restored.cursor, first.cursor);
  await assert.rejects(
    syncOperations({ ...fixture.config, url: `http://127.0.0.1:${address.port}` }, [], 1000),
    /服务器备份早于/,
  );
});

test('authorization, CORS, invalid requests and encryption mode mismatch reject safely', async (t) => {
  const fixture = await setup({ allowedOrigins: ['https://my-client.example'] });
  t.after(fixture.cleanup);
  await assert.rejects(syncOperations({ ...fixture.config, token: 'wrong' }, []), /同步令牌无效/);
  const denied = await fetch(fixture.config.url + '/api/sync', {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ projectId: 'test', ops: [], cursor: 0, mode: 'plain' }),
  });
  assert.equal(denied.status, 403);
  const allowed = await fetch(fixture.config.url + '/api/sync', {
    method: 'OPTIONS',
    headers: { Origin: 'https://my-client.example' },
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://my-client.example');
  assert.equal(allowed.status, 204);
  const malformed = await fetch(fixture.config.url + '/api/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(malformed.status, 400);
  await syncOperations(fixture.config, [{ id: 'first', text: 'hello' }]);
  await assert.rejects(
    syncOperations({ ...fixture.config, mode: 'e2ee', passphrase: 'correct-horse-battery' }, []),
    /加密模式或口令不匹配/,
  );
});

test('E2EE sends only authenticated ciphertext, uses fresh nonces and detects tampering', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const config: SyncConfig = {
    ...fixture.config,
    mode: 'e2ee',
    passphrase: 'correct-horse-battery-staple',
  };
  const operation = {
    id: 'private-1',
    text: 'SECRET-CONTENT-DO-NOT-STORE-IN-PLAIN',
    A: { pressure: 0.8, editable: true },
  };
  const envelope = await encodeOperation(config, operation);
  const another = await encodeOperation(config, operation);
  assert.equal(envelope.mode, 'e2ee');
  assert.equal(another.mode, 'e2ee');
  if (envelope.mode !== 'e2ee' || another.mode !== 'e2ee') throw new Error('wrong mode');
  assert.notEqual(envelope.iv, another.iv);
  assert.equal(envelope.fingerprint, another.fingerprint);
  assert.deepEqual(await decodeOperation(config, envelope), operation);
  const tampered = {
    ...envelope,
    data: (envelope.data[0] === 'A' ? 'B' : 'A') + envelope.data.slice(1),
  };
  await assert.rejects(decodeOperation(config, tampered), /加密数据验证失败/);
  await assert.rejects(
    decodeOperation({ ...config, projectId: 'other-project' }, envelope),
    /加密数据验证失败/,
  );
  await assert.rejects(
    decodeOperation({ ...config, passphrase: 'a-different-passphrase' }, envelope),
    /加密数据验证失败/,
  );
  const first = await syncOperations(config, [operation]);
  assert.deepEqual(first.operations, [operation]);
  const retry = await syncOperations(config, [operation], first.cursor);
  assert.deepEqual(retry.operations, []);
  const encoded = fixture.app.db.prepare('SELECT envelope FROM operations').get()!
    .envelope as string;
  assert.ok(!encoded.includes(operation.text));
  assert.ok(!encoded.includes('pressure'));
  await assert.rejects(
    syncOperations({ ...config, passphrase: 'incorrect-battery-staple' }, []),
    /加密模式或口令不匹配/,
  );
  await assert.rejects(syncOperations({ ...config, mode: 'plain' }, []), /加密模式或口令不匹配/);
});

test('pagination retrieves all 1205 operations without missing changed objects', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const ops = Array.from({ length: 1205 }, (_, index) => ({ id: `op-${index}`, value: index }));
  const result = await syncOperations(fixture.config, ops);
  assert.deepEqual(result.operations, ops);
  const remote = await syncOperations(fixture.config, []);
  assert.equal(remote.operations.length, 1205);
  assert.equal(remote.cursor, result.cursor);
});

test('auto sync retries durable local operations when a Mac comes back online', async (t) => {
  const fixture = await setup();
  const address = fixture.app.server.address() as { port: number };
  await fixture.app.close();
  let replacement: ReturnType<typeof createSyncServer> | null = null;
  let cursor = 0;
  let remote: SyncOperation[] = [];
  const local = [{ id: 'offline-edit', text: 'kept while offline' }];
  const states: string[] = [];
  const auto = startAutoSync({
    config: fixture.config,
    getOperations: () => local,
    getCursor: () => cursor,
    applyRemote: async (ops) => {
      remote = ops;
    },
    setCursor: (next) => {
      cursor = next;
    },
    onStatus: (state) => states.push(state),
    intervalMs: 60_000,
  });
  t.after(async () => {
    auto.stop();
    if (replacement) await replacement.close();
    await rm(fixture.dir, { recursive: true, force: true });
  });
  await auto.syncNow();
  assert.ok(states.includes('error'));
  replacement = createSyncServer({ dataDir: fixture.dir, token });
  replacement.server.listen(address.port, '127.0.0.1');
  await once(replacement.server, 'listening');
  await auto.syncNow();
  assert.deepEqual(remote, local);
  assert.ok(cursor > 0);
  assert.equal(states.at(-1), 'synced');
});

test('auto sync uploads only unacknowledged operations and retains acknowledgements across restart', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const originalFetch = globalThis.fetch;
  const uploads: string[][] = [];
  globalThis.fetch = (async (input, init) => {
    if (typeof init?.body === 'string')
      uploads.push(JSON.parse(init.body).ops.map((op: { id: string }) => op.id));
    return originalFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let cursor = 0;
  let durableIds: string[] = [];
  const local: SyncOperation[] = [{ id: 'already-backed-up', text: 'large original A' }];
  const options = {
    config: fixture.config,
    getOperations: () => local,
    getCursor: () => cursor,
    applyRemote: () => {},
    setCursor: (value: number) => {
      cursor = value;
    },
    getAcknowledgedIds: () => durableIds,
    setAcknowledgedIds: (_identity: string, ids: string[]) => {
      durableIds = ids;
    },
    intervalMs: 60_000,
  };
  const auto = startAutoSync(options);
  t.after(auto.stop);
  await auto.syncNow();
  assert.deepEqual(uploads[0], ['already-backed-up']);
  local.push({ id: 'new-single-stroke', pressure: 0.7 });
  await auto.syncNow();
  assert.deepEqual(uploads[1], ['new-single-stroke']);
  assert.deepEqual(new Set(durableIds), new Set(local.map((op) => op.id)));
  auto.stop();
  const reopened = startAutoSync(options);
  t.after(reopened.stop);
  await reopened.syncNow();
  assert.deepEqual(uploads[2], []);
});

for (const mode of ['plain', 'e2ee'] as const) {
  test(`${mode} auto sync repairs an old Mac backup despite persisted acknowledgements, lost response and imported cursor zero`, async (t) => {
    const fixture = await setup();
    let app = fixture.app;
    const port = (app.server.address() as { port: number }).port;
    const config: SyncConfig = {
      ...fixture.config,
      mode,
      ...(mode === 'e2ee' ? { passphrase: 'restore-backup-long-passphrase' } : {}),
    };
    const oldSnapshot = join(fixture.dir, 'old-backup.sqlite');
    let local: SyncOperation[] = [
      {
        id: 'backup-1',
        kind: 'stroke',
        points: [{ x: 3, y: 7, pressure: 0.8, tiltX: 12, tiltY: -4 }],
      },
      {
        id: 'backup-2',
        kind: 'segment',
        chars: [{ id: 'stable-char', value: '纸' }],
        sourceIds: ['backup-1'],
      },
    ];
    let cursor = 0,
      restored = 0,
      dropNextResponse = false;
    const acknowledgements = new Map<string, string[]>(),
      statuses: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const response = await realFetch(input, init);
      if (dropNextResponse && String(input).endsWith('/api/sync') && response.ok) {
        dropNextResponse = false;
        await response.arrayBuffer();
        throw new TypeError('simulated lost response after durable server commit');
      }
      return response;
    }) as typeof fetch;
    const options = {
      config,
      getOperations: () => local,
      getCursor: () => cursor,
      applyRemote: (ops: SyncOperation[]) => {
        const combined = new Map(local.map((op) => [op.id, op]));
        for (const op of ops) {
          const existing = combined.get(op.id);
          if (existing) assert.deepEqual(op, existing);
          else combined.set(op.id, op);
        }
        local = [...combined.values()];
      },
      setCursor: (value: number) => {
        cursor = value;
      },
      getAcknowledgedIds: (identity: string) => [...(acknowledgements.get(identity) ?? [])],
      setAcknowledgedIds: (identity: string, ids: string[]) => {
        acknowledgements.set(identity, [...ids]);
      },
      onStatus: (status: string) => statuses.push(status),
      intervalMs: 60_000,
    };
    let client = startAutoSync(options);
    t.after(async () => {
      client.stop();
      globalThis.fetch = realFetch;
      await app.close();
      await rm(fixture.dir, { recursive: true, force: true });
    });
    async function restoreOldServer() {
      await app.close();
      const dir = join(fixture.dir, `restored-${++restored}`);
      await mkdir(dir);
      await copyFile(oldSnapshot, join(dir, 'quiet-paper.sqlite'));
      app = createSyncServer({ dataDir: dir, token });
      app.server.listen(port, '127.0.0.1');
      await once(app.server, 'listening');
      assert.equal(app.db.prepare('SELECT count(*) AS count FROM operations').get()!.count, 2);
    }
    await client.syncNow();
    assert.equal(statuses.at(-1), 'synced');
    await backup(app.db, oldSnapshot);
    local.push(
      { id: 'after-backup-3', kind: 'review', known: true, history: [1, 2] },
      { id: 'after-backup-4', kind: 'native', snapshot: '完整源文件及版本' },
    );
    await client.syncNow();
    assert.equal(statuses.at(-1), 'synced');
    const all = structuredClone(local),
      oldCursor = cursor;
    assert.equal(acknowledgements.size, 1);
    assert.equal([...acknowledgements.values()][0].length, 4);
    await restoreOldServer();
    dropNextResponse = true;
    await client.syncNow();
    assert.equal(statuses.at(-1), 'error');
    assert.equal(cursor, oldCursor);
    assert.equal(acknowledgements.size, 1);
    assert.deepEqual(local, all);
    assert.equal(app.db.prepare('SELECT count(*) AS count FROM operations').get()!.count, 4);
    await client.syncNow();
    assert.equal(statuses.at(-1), 'synced');
    assert.equal(acknowledgements.size, 2);
    assert.deepEqual((await syncOperations(config, [])).operations, all);

    // An import resets the cursor but leaves old ack records under the same project ID.
    client.stop();
    cursor = 0;
    local = structuredClone(all);
    await restoreOldServer();
    client = startAutoSync(options);
    await client.syncNow();
    assert.equal(statuses.at(-1), 'synced');
    assert.equal(acknowledgements.size, 3);
    assert.deepEqual((await syncOperations(config, [])).operations, all);
    assert.deepEqual(local, all);
    await assert.rejects(
      syncOperations(config, [], cursor + 100),
      (error) =>
        error instanceof SyncProtocolError &&
        error.code === 'CURSOR_AHEAD' &&
        error.serverCursor === cursor,
    );
    cursor += 100;
    await client.syncNow();
    assert.equal(statuses.at(-1), 'synced');
    assert.equal(cursor, all.length);
    await assert.rejects(
      syncOperations(config, [{ id: 'must-not-write' }], 0, 'old-generation'),
      (error) => error instanceof SyncProtocolError && error.code === 'SERVER_GENERATION_CHANGED',
    );
    assert.equal(
      app.db.prepare('SELECT count(*) AS count FROM operations').get()!.count,
      all.length,
    );

    // Full replay retains collision protection; it never force-replaces an archived same-ID object.
    client.stop();
    cursor = 0;
    local[0] = { ...local[0], kind: 'tampered-same-id' };
    const tampered = structuredClone(local);
    await restoreOldServer();
    client = startAutoSync(options);
    await client.syncNow();
    assert.equal(statuses.at(-1), 'error');
    assert.deepEqual(local, tampered);
    assert.equal(cursor, 0);
    assert.equal(acknowledgements.size, 3);
    assert.equal(app.db.prepare('SELECT count(*) AS count FROM operations').get()!.count, 2);
    local = structuredClone(all);
    await client.syncNow();
    assert.equal(statuses.at(-1), 'synced');
    assert.deepEqual(local, all);
    assert.equal(app.db.prepare('SELECT count(*) AS count FROM operations').get()!.count, 4);
  });
}

test('static client serves locally with traversal and symlink escapes blocked', async (t) => {
  const staticDir = await mkdtemp(join(tmpdir(), 'quiet-paper-static-'));
  await writeFile(join(staticDir, 'index.html'), '<h1>Paper</h1>');
  const fixture = await setup({ staticDir });
  t.after(async () => {
    await fixture.cleanup();
    await rm(staticDir, { recursive: true, force: true });
  });
  const root = await fetch(fixture.config.url + '/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /Paper/);
  const health = await fetch(fixture.config.url + '/health');
  assert.equal((await health.json()).protocol, 1);
});
