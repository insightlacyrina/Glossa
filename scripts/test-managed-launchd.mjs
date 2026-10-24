import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// macOS integration check. Uses a unique temporary launchd job and database.
// Never installs a login agent, touches the normal server, or kills by port.
assert.equal(process.platform, 'darwin', 'This check requires macOS launchd');
const exec = promisify(execFile);
const bundled = resolve(process.argv[2] ?? 'releases/macos/Glossa.app/Contents/Resources/server-runtime');
const root = await mkdtemp(join(tmpdir(), 'glossa-launchd-'));
const runtime = join(root, 'runtime');
const label = 'local.glossa.test.' + randomUUID().toLowerCase();
const domain = 'gui/' + process.getuid();
const target = domain + '/' + label;
const reserve = createServer().listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(accept => reserve.close(accept));
const configPath = join(root, 'server-config.json');
const config = { version: 1, instanceId: randomUUID(), host: '127.0.0.1', port,
  token: randomUUID(), adminToken: randomUUID(), dataDir: join(root, 'data'),
  backupDir: join(root, 'backups'), staticDir: join(runtime, 'web'), allowedOrigins: [],
  backupIntervalHours: 24, retentionCount: 14,
  ai: { enabled: false, endpoint: '', model: '', apiKey: '' } };
const plist = join(root, 'service.plist');
const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
let loaded = false;
const checks = [];
try {
  await cp(bundled, runtime, { recursive: true });
  await mkdir(config.dataDir);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const node = join(runtime, 'node'), managed = join(runtime, 'server/managed.mjs');
  const cli = async (command, id) => JSON.parse((await exec(node, [managed, command, '--config', configPath,
    ...(id ? ['--id', id] : [])], { timeout: 40_000 })).stdout.trim());
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[node, managed, 'serve', '--config', configPath].map(value => '<string>' + escaped(value) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>${escaped(join(root, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${escaped(join(root, 'stderr.log'))}</string></dict></plist>`, { mode: 0o600 });
  const waitFor = async running => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await cli('status');
      if (status.running === running && (running || !status.locked)) return status;
      await new Promise(accept => setTimeout(accept, 200));
    }
    throw new Error('Timed out waiting for launchd state');
  };
  const start = async () => { loaded = true; await exec('/bin/launchctl', ['bootstrap', domain, plist]); return waitFor(true); };
  const stop = async () => { await exec('/bin/launchctl', ['bootout', target]); const status = await waitFor(false); loaded = false; return status; };
  const first = await start();
  assert.equal(first.instanceId, config.instanceId);
  assert.ok(first.pid > 0);
  checks.push('bundled runtime copied outside repo starts with real launchd');
  const later = await cli('status');
  assert.equal(later.pid, first.pid);
  checks.push('server survives launching client process exit');
  const sync = async id => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sync`, { method: 'POST',
      headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'launchd-project', mode: 'plain', keyId: null, cursor: 0,
        ops: [{ id, mode: 'plain', payload: { id, text: '真实后台服务增量归档' } }] }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await sync('launchd-old');
  assert.equal((await cli('projects')).projects[0].operations, 1);
  const backup = (await cli('backup')).backup;
  assert.equal(backup.verified, true);
  assert.equal((await cli('verify-backup', backup.id)).backup.operations, 1);
  await sync('launchd-new');
  await assert.rejects(cli('restore', backup.id), error => JSON.parse(error.stdout).error.code === 'RESTORE_SERVICE_RUNNING');
  checks.push('real HTTP archive, online snapshot and active restore refusal');
  await stop();
  const restored = await cli('restore', backup.id);
  assert.ok(restored.restored.safetyBackupId);
  assert.equal((await cli('verify-backup', restored.restored.safetyBackupId)).backup.operations, 2);
  assert.equal((await cli('projects')).projects[0].operations, 1);
  await start();
  const rebuilt = await sync('launchd-new');
  assert.notEqual(initial.generation, rebuilt.generation);
  assert.equal(rebuilt.ops.length, 2);
  assert.equal((await cli('projects')).projects[0].operations, 2);
  checks.push('stopped restore preserves newer safety archive; fresh generation replenishes operations');
  await stop();
  console.log(JSON.stringify({ ok: true, platform: process.platform, architecture: process.arch, checks }, null, 2));
} finally {
  let removable = !loaded;
  if (loaded) {
    await exec('/bin/launchctl', ['bootout', target]).catch(() => {});
    try {
      await exec('/bin/launchctl', ['print', target]);
    } catch (error) {
      if (error.code === 113) {
        const result = await exec(join(runtime, 'node'), [join(runtime, 'server/managed.mjs'), 'status', '--config', configPath]).catch(() => null);
        if (result?.stdout.trim()) {
          try {
            const status = JSON.parse(result.stdout);
            removable = status.running === false && status.locked === false;
          } catch { /* Preserve evidence rather than masking the original failure. */ }
        }
      }
    }
  }
  if (removable) await rm(root, { recursive: true, force: true });
  else {
    console.error('Temporary service did not confirm shutdown; retained directory for inspection:', root);
    process.exitCode = 1;
  }
}
