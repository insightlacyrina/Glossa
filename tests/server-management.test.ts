import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, writeFile, readFile, appendFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  randomUUID,
  createECDH,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createSyncServer } from '../server/app.mjs';
import { serveManaged, runManagedCommand, managedStatus } from '../server/managed.mjs';
import {
  validateManagedConfig,
  readManagedConfig,
  atomicJSON,
  acquireDatabaseLease,
  leaseIsHeld,
  ArchiveManager,
  verifyBackup,
  listBackups,
  restoreArchive,
  type ManagedConfig,
} from '../server/management.mjs';
import { syncOperations, startAutoSync, type SyncConfig } from '../src/sync.ts';

const exec = promisify(execFile);
async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return port;
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'glossa-server-management-'));
  const config = validateManagedConfig({
    version: 1,
    instanceId: randomUUID(),
    host: '127.0.0.1',
    port: await unusedPort(),
    token: 'sync-' + randomUUID(),
    adminToken: 'admin-' + randomUUID(),
    dataDir: join(dir, 'data'),
    backupDir: join(dir, 'backups'),
    allowedOrigins: ['https://appassets.quietpaper.local'],
    backupIntervalHours: 24,
    retentionCount: 14,
    ai: { enabled: false, endpoint: '', model: '', apiKey: '' },
  });
  const path = join(dir, 'server.json');
  atomicJSON(path, config);
  return { dir, config, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const url = (config: ManagedConfig) => `http://127.0.0.1:${config.port}`;
const syncConfig = (config: ManagedConfig): SyncConfig => ({
  url: url(config),
  token: config.token,
  projectId: 'managed-project',
  mode: 'plain',
});
function api(config: ManagedConfig, path: string, options: RequestInit = {}, admin = true) {
  return fetch(url(config) + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + (admin ? config.adminToken : config.token),
      ...options.headers,
    },
  });
}

test('managed configuration requires private owner credentials, safe paths and explicit AI settings', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  assert.equal(readManagedConfig(fixture.path).instanceId, fixture.config.instanceId);
  for (const patch of [
    { version: 2 },
    { instanceId: 'not-uuid' },
    { adminToken: fixture.config.token },
    { token: 'short' },
    { dataDir: '../data' },
    { backupDir: fixture.config.dataDir },
    { allowedOrigins: ['*'] },
    { port: 0 },
    { host: 'example.com' },
    { backupIntervalHours: 0 },
    { retentionCount: 0 },
    { ai: { enabled: true, endpoint: 'https://provider.invalid/v1', model: 'm', apiKey: 'key' } },
    {
      ai: {
        enabled: true,
        endpoint: 'https://provider.invalid/chat/completions?api_key=secret',
        model: 'm',
        apiKey: 'key',
      },
    },
    {
      ai: {
        enabled: true,
        endpoint: 'http://remote.invalid/chat/completions',
        model: 'm',
        apiKey: 'key',
      },
    },
  ]) {
    assert.throws(() => validateManagedConfig({ ...fixture.config, ...patch }), /无效|必须|需要/);
  }
  await chmod(fixture.path, 0o644);
  assert.throws(() => readManagedConfig(fixture.path), /600/);
  await chmod(fixture.path, 0o600);
  const linked = join(fixture.dir, 'config-link.json');
  await symlink(fixture.path, linked);
  assert.throws(() => readManagedConfig(linked), /符号链接/);
});

test('admin scope requires a real loopback peer, no Origin and a different token from sync', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const app = await serveManaged(fixture.config);
  t.after(() => app.close());
  await syncOperations(syncConfig(fixture.config), [{ id: 'scope-op', text: '原稿' }]);
  const syncStatus = await (await api(fixture.config, '/api/status', {}, false)).json();
  assert.equal(syncStatus.protocol, 1);
  assert.equal(syncStatus.aiProxyAvailable, false);
  assert.equal(syncStatus.serverCanDecryptE2EE, false);
  assert.equal((await api(fixture.config, '/api/admin/status', {}, false)).status, 401);
  for (const origin of ['null', 'https://appassets.quietpaper.local', url(fixture.config)])
    assert.equal(
      (await api(fixture.config, '/api/admin/status', { headers: { Origin: origin } })).status,
      403,
    );
  assert.equal((await api(fixture.config, '/api/admin/restore', { method: 'POST' })).status, 404);
  const status = await managedStatus(fixture.config);
  assert.equal(status.running, true);
  assert.equal(status.instanceId, fixture.config.instanceId);
  assert.equal(status.projects, 1);
  assert.equal(status.operations, 1);
  assert.ok(status.backup.nextAt);
  assert.deepEqual(
    (await runManagedCommand('projects', fixture.config)).projects.map((p: any) => [
      p.id,
      p.mode,
      p.operations,
    ]),
    [['managed-project', 'plain', 1]],
  );
  assert.equal(
    (
      await api(fixture.config, '/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.throws(
    () => createSyncServer({ dataDir: fixture.config.dataDir, token: fixture.config.token }),
    /另一进程/,
  );
  assert.equal(leaseIsHeld(fixture.config.dataDir), true);
  const created = (await runManagedCommand('backup', fixture.config)).backup;
  assert.equal(created.verified, true);
  assert.equal(created.operations, 1);
  await assert.rejects(
    restoreArchive(fixture.config, created.id),
    (error: any) => error.code === 'RESTORE_SERVICE_RUNNING',
  );
});

test('online snapshots have verified manifests; failed backup preserves valid history and retention ignores damaged copies', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const app = createSyncServer({ dataDir: fixture.config.dataDir, token: fixture.config.token });
  t.after(() => app.close());
  let now = Date.now();
  const manager = new ArchiveManager({
    ...fixture.config,
    db: app.db,
    retentionCount: 2,
    now: () => ++now,
  });
  const first = await manager.create();
  const path = join(fixture.config.backupDir, first.id);
  await appendFile(path, 'damage');
  await assert.rejects(verifyBackup(fixture.config.backupDir, first.id), /清单|校验/);
  const damaged = (await listBackups(fixture.config.backupDir)).find(
    (item) => item.id === first.id,
  )!;
  assert.equal(damaged.verified, false);
  const orphanID = `glossa-2026-01-01T00-00-00-000Z-${randomUUID()}.sqlite`;
  await writeFile(join(fixture.config.backupDir, orphanID + '.manifest.json'), '{}');
  assert.ok(
    (await listBackups(fixture.config.backupDir)).some(
      (item) => item.id === orphanID && !item.verified,
    ),
  );
  const second = await manager.create();
  const third = await manager.create();
  const fourth = await manager.create();
  const records = await listBackups(fixture.config.backupDir);
  assert.deepEqual(
    new Set(records.filter((item) => item.verified).map((item) => item.id)),
    new Set([third.id, fourth.id]),
  );
  assert.ok(
    records.some((item) => item.id === first.id && !item.verified),
    'retention must preserve damaged evidence',
  );
  assert.ok(!records.some((item) => item.id === second.id));
  const before = records.map((item) => item.id).sort();
  const failing = new ArchiveManager({
    ...fixture.config,
    db: app.db,
    retentionCount: 1,
    fault: (point) => {
      if (point === 'before-backup-commit') throw new Error('simulated disk failure');
    },
  });
  await assert.rejects(failing.create(), /备份创建失败/);
  assert.deepEqual(
    (await listBackups(fixture.config.backupDir)).map((item) => item.id).sort(),
    before,
  );
});

test('automatic snapshot scheduling runs inside the service and stops cleanly', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const app = createSyncServer({
    dataDir: fixture.config.dataDir,
    token: fixture.config.token,
    management: { ...fixture.config, intervalMs: 40 },
  });
  t.after(() => app.close());
  const deadline = Date.now() + 4000;
  while (
    (await listBackups(fixture.config.backupDir)).filter((item) => item.verified).length < 2 &&
    Date.now() < deadline
  )
    await new Promise((accept) => setTimeout(accept, 20));
  assert.ok(
    (await listBackups(fixture.config.backupDir)).filter((item) => item.verified).length >= 2,
  );
  await app.close();
  const count = (await listBackups(fixture.config.backupDir)).length;
  await new Promise((accept) => setTimeout(accept, 100));
  assert.equal((await listBackups(fixture.config.backupDir)).length, count);
  assert.equal(leaseIsHeld(fixture.config.dataDir), false);
});

for (const mode of ['plain', 'e2ee'] as const)
  test(`${mode} stopped restore retains a safety backup and clients replenish newer immutable operations`, async (t) => {
    const fixture = await setup();
    t.after(fixture.cleanup);
    let app = await serveManaged(fixture.config);
    t.after(() => app.close());
    const config: SyncConfig = {
      ...syncConfig(fixture.config),
      mode,
      ...(mode === 'e2ee' ? { passphrase: 'managed-recovery-long-passphrase' } : {}),
    };
    const operations = [
      { id: 'restore-old-op', text: '原稿', points: [{ pressure: 0.7 }] },
      { id: 'restore-new-op', text: '离线修订' },
    ];
    const initial = await syncOperations(config, [operations[0]]);
    const older = (await runManagedCommand('backup', fixture.config)).backup;
    const newer = await syncOperations(
      config,
      operations,
      initial.cursor,
      initial.serverGeneration,
    );
    await app.close();
    const restored = await restoreArchive(fixture.config, older.id);
    assert.ok(restored.safetyBackupId);
    assert.equal(
      (await verifyBackup(fixture.config.backupDir, restored.safetyBackupId!)).operations,
      2,
    );
    const disk = new DatabaseSync(join(fixture.config.dataDir, 'quiet-paper.sqlite'), {
      readOnly: true,
    });
    assert.equal(disk.prepare('SELECT count(*) AS n FROM operations').get()!.n, 1);
    disk.close();
    app = await serveManaged(fixture.config);
    assert.notEqual(app.generation, newer.serverGeneration);
    const keyID = mode === 'plain' ? 'plain' : 'not-the-new-generation';
    const acknowledgements = new Map([
      [
        `${config.url}|${config.projectId}|${mode}|${keyID}|${newer.serverGeneration}`,
        operations.map((op) => op.id),
      ],
    ]);
    let cursor = newer.cursor,
      applied: string[] = [],
      status = '';
    const client = startAutoSync({
      config,
      getOperations: () => operations,
      getCursor: () => cursor,
      getAcknowledgedIds: (identity) => acknowledgements.get(identity) ?? [],
      setAcknowledgedIds: (identity, ids) => {
        acknowledgements.set(identity, ids);
      },
      applyRemote: (ops) => {
        applied = ops.map((op) => op.id);
      },
      setCursor: (value) => {
        cursor = value;
      },
      onStatus: (value) => {
        status = value;
      },
      intervalMs: 60_000,
    });
    try {
      await client.syncNow();
    } finally {
      client.stop();
    }
    assert.equal(status, 'synced');
    assert.deepEqual(new Set(applied), new Set(operations.map((op) => op.id)));
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM operations').get()!.n, 2);
  });

test('restore rejects paths, corrupt or foreign backups, and rolls back an interrupted installation', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const app = await serveManaged(fixture.config);
  await syncOperations(syncConfig(fixture.config), [{ id: 'rollback-old', text: 'before' }]);
  const backup = (await runManagedCommand('backup', fixture.config)).backup;
  await syncOperations(syncConfig(fixture.config), [{ id: 'rollback-new', text: 'after' }]);
  await app.close();
  await assert.rejects(restoreArchive(fixture.config, '../quiet-paper.sqlite'), /标识/);
  await assert.rejects(
    restoreArchive({ ...fixture.config, instanceId: randomUUID() }, backup.id),
    /另一服务器/,
  );
  await assert.rejects(
    restoreArchive(fixture.config, backup.id, {
      fault: (point) => {
        if (point === 'after-restore-install') throw new Error('simulated crash');
      },
    }),
    /恢复失败/,
  );
  const db = new DatabaseSync(join(fixture.config.dataDir, 'quiet-paper.sqlite'), {
    readOnly: true,
  });
  assert.equal(db.prepare('SELECT count(*) AS n FROM operations').get()!.n, 2);
  db.close();
  await appendFile(join(fixture.config.backupDir, backup.id), 'damage');
  await assert.rejects(restoreArchive(fixture.config, backup.id), /校验|清单/);
  assert.equal(leaseIsHeld(fixture.config.dataDir), false);
});

test('managed CLI starts through symlinks, survives its launching client, rejects duplicates, and releases its lease after a crash', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const command = resolve('server/managed.mjs');
  const linkedCommand = join(fixture.dir, 'managed-link.mjs');
  await symlink(command, linkedCommand);
  const cli = async (action: string, id?: string) => {
    const result = await exec(process.execPath, [
      linkedCommand,
      action,
      '--config',
      fixture.path,
      ...(id ? ['--id', id] : []),
    ]);
    return JSON.parse(result.stdout.trim());
  };
  assert.equal((await cli('status')).running, false);
  const child = spawn(process.execPath, [linkedCommand, 'serve', '--config', fixture.path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, 'line'),
    once(child, 'exit').then(() => {
      throw new Error('managed CLI exited before ready');
    }),
  ]);
  assert.equal(JSON.parse(String(line)).running, true);
  assert.equal((await cli('status')).running, true);
  const fresh = await cli('backup');
  assert.equal(fresh.backup.verified, true);
  await assert.rejects(
    cli('serve'),
    (error: any) => JSON.parse(error.stdout).error.code === 'SERVICE_BUSY',
  );
  await assert.rejects(
    cli('restore', fresh.backup.id),
    (error: any) => JSON.parse(error.stdout).error.code === 'RESTORE_SERVICE_RUNNING',
  );
  child.kill('SIGKILL');
  await once(child, 'exit');
  lines.close();
  assert.equal((await cli('status')).running, false);
  assert.equal((await cli('verify-backup', fresh.backup.id)).backup.verified, true);
  assert.equal((await cli('restore', fresh.backup.id)).restored.id, fresh.backup.id);
  assert.ok((await cli('list-backups')).backups.length >= 2);
});

test('AI proxy stays behind sync auth and origin checks and never adds temporary plaintext to the operation archive', async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {
      /* consume the scoped request */
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                objects: [
                  { id: 'scope-object', version: 'version-1', text: '候选', uncertainty: [] },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise<void>((accept) => provider.close(() => accept())));
  const app = await serveManaged({
    ...fixture.config,
    ai: {
      enabled: true,
      endpoint: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`,
      model: 'local-fixture',
      apiKey: 'owner-test-api-key',
    },
  });
  t.after(() => app.close());
  assert.equal((await api(fixture.config, '/api/status', {}, false)).status, 200);
  const status = await (await api(fixture.config, '/api/status', {}, false)).json();
  assert.equal(status.aiProxyAvailable, true);
  assert.equal(status.serverCanDecryptE2EE, false);
  assert.equal((await fetch(url(fixture.config) + '/api/ai/status')).status, 401);
  assert.equal(
    (
      await api(
        fixture.config,
        '/api/ai/status',
        { headers: { Origin: 'https://untrusted.invalid' } },
        false,
      )
    ).status,
    403,
  );
  const peer = createECDH('prime256v1');
  peer.generateKeys();
  const grantResponse = await api(
    fixture.config,
    '/api/ai/grants',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        consent: true,
        projectId: 'scoped-project',
        purpose: 'transcribe',
        objects: [{ id: 'scope-object', version: 'version-1' }],
        ttlSeconds: 60,
        clientPublicKey: peer.getPublicKey().toString('base64'),
      }),
    },
    false,
  );
  assert.equal(grantResponse.status, 201);
  const grant = await grantResponse.json();
  const shared = peer.computeSecret(Buffer.from(grant.serverPublicKey, 'base64'));
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.from(grant.salt, 'base64'),
      Buffer.from('glossa-ai-proxy-v1\0' + grant.grantId + '\0scoped-project'),
      32,
    ),
  );
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify(['glossa-ai-proxy-v1', grant.grantId, 'scoped-project', 'transcribe']),
    ),
  );
  const plaintext = JSON.stringify({
    projectId: 'scoped-project',
    purpose: 'transcribe',
    objects: [{ id: 'scope-object', version: 'version-1', kind: 'text', text: '临时授权片段' }],
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const job = await api(
    fixture.config,
    `/api/ai/grants/${grant.grantId}/jobs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: 'job-1',
        iv: iv.toString('base64'),
        data: encrypted.toString('base64'),
      }),
    },
    false,
  );
  assert.equal(job.status, 200);
  const encryptedCandidate = await job.json();
  assert.equal(encryptedCandidate.encryption, 'aes-256-gcm');
  const candidateData = Buffer.from(encryptedCandidate.data, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encryptedCandidate.iv, 'base64'),
  );
  decipher.setAAD(
    Buffer.from(
      JSON.stringify(['glossa-ai-proxy-v1', grant.grantId, 'scoped-project', 'candidate', 'job-1']),
    ),
  );
  decipher.setAuthTag(candidateData.subarray(-16));
  const candidate = JSON.parse(
    Buffer.concat([decipher.update(candidateData.subarray(0, -16)), decipher.final()]).toString(
      'utf8',
    ),
  );
  assert.equal(candidate.candidate, true);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM operations').get()!.n, 0);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM projects').get()!.n, 0);
});
