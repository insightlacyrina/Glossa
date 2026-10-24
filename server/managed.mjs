import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createSyncServer } from './app.mjs';
import {
  ManagementError,
  readManagedConfig,
  acquireDatabaseLease,
  leaseIsHeld,
  archiveProjects,
  ArchiveManager,
  listBackups,
  verifyBackup,
  restoreArchive,
  databaseName,
  atomicJSON,
} from './management.mjs';

export function localServerURL(config) {
  return `http://${config.host === '::' || config.host === '::1' ? '[::1]' : config.host === 'localhost' ? 'localhost' : '127.0.0.1'}:${config.port}`;
}
async function adminRequest(config, path, body) {
  let response;
  try {
    response = await fetch(localServerURL(config) + '/api/admin/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + config.adminToken, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new ManagementError('SERVICE_UNREACHABLE', '无法连接本机服务器；配置与数据均已保留');
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new ManagementError('INVALID_RESPONSE', '本机端口未返回有效的管理响应');
  }
  if (!response.ok || value.ok !== true)
    throw new ManagementError(
      typeof value.error === 'string' ? value.error : 'ADMIN_REQUEST_FAILED',
      typeof value.message === 'string'
        ? value.message
        : response.status === 401
          ? '管理密钥无效；该端口可能属于另一服务实例'
          : '本机服务器拒绝管理请求',
    );
  return value;
}
export async function managedStatus(config) {
  const value = await adminRequest(config, 'status');
  if (value) {
    if (value.instanceId !== config.instanceId)
      throw new ManagementError('INSTANCE_MISMATCH', '本机端口属于另一服务器实例，未执行管理操作');
    return value;
  }
  return {
    ok: true,
    running: false,
    instanceId: config.instanceId,
    url: localServerURL(config),
    locked: leaseIsHeld(config.dataDir),
  };
}

export async function serveManaged(config, { onReady = () => {} } = {}) {
  const lease = acquireDatabaseLease(config.dataDir);
  let app;
  const runtimePath = join(config.dataDir, '.glossa-runtime.json');
  try {
    app = createSyncServer({
      dataDir: config.dataDir,
      token: config.token,
      staticDir: config.staticDir,
      allowedOrigins: config.allowedOrigins,
      lease,
      ai: config.ai,
      management: { ...config, url: localServerURL(config) },
    });
    app.server.listen(config.port, config.host);
    await once(app.server, 'listening');
    const ready = {
      ok: true,
      running: true,
      instanceId: config.instanceId,
      pid: process.pid,
      url: localServerURL(config),
      startedAt: new Date().toISOString(),
    };
    atomicJSON(runtimePath, ready);
    onReady(ready);
    let closed;
    return {
      ...app,
      close: () =>
        (closed ??= (async () => {
          try {
            await app.close();
          } finally {
            try {
              unlinkSync(runtimePath);
            } catch {}
          }
        })()),
    };
  } catch (error) {
    if (app) await app.close().catch(() => {});
    else lease.release();
    if (error.code === 'EADDRINUSE')
      throw new ManagementError('PORT_IN_USE', '服务器端口已被占用，请选择其它端口');
    throw error;
  }
}

export async function runManagedCommand(command, config, id) {
  if (command === 'status') return managedStatus(config);
  if (command === 'list-backups') return { ok: true, backups: await listBackups(config.backupDir) };
  if (command === 'verify-backup')
    return { ok: true, backup: await verifyBackup(config.backupDir, id) };
  if (command === 'restore') return { ok: true, restored: await restoreArchive(config, id) };
  if (!['projects', 'backup'].includes(command))
    throw new ManagementError('UNKNOWN_COMMAND', '未知的服务器管理命令');
  const status = await managedStatus(config);
  if (status.running) {
    const result = await adminRequest(
      config,
      command === 'projects' ? 'projects' : 'backup',
      command === 'backup' ? {} : undefined,
    );
    if (!result)
      throw new ManagementError('SERVICE_STOPPED', '服务器在操作期间停止；未确认备份已创建');
    return result;
  }
  const lease = acquireDatabaseLease(config.dataDir);
  let db;
  try {
    const path = join(config.dataDir, databaseName);
    if (!existsSync(path)) {
      if (command === 'projects') return { ok: true, projects: [] };
      throw new ManagementError('NO_DATABASE', '尚无同步数据库可供备份，请先启动服务');
    }
    db = new DatabaseSync(path, { readOnly: true });
    if (command === 'projects') return { ok: true, projects: archiveProjects(db) };
    const manager = new ArchiveManager({ ...config, db });
    return { ok: true, backup: await manager.create() };
  } finally {
    try {
      db?.close();
    } finally {
      lease.release();
    }
  }
}

async function main() {
  const args = process.argv.slice(2),
    command = args.shift();
  if (
    !['serve', 'status', 'projects', 'backup', 'list-backups', 'verify-backup', 'restore'].includes(
      command,
    )
  )
    throw new ManagementError('UNKNOWN_COMMAND', '请指定有效的服务器管理命令');
  let path, id;
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    if (key === '--config' && !path && value) path = value;
    else if (key === '--id' && !id && value) id = value;
    else throw new ManagementError('INVALID_ARGUMENTS', '服务器管理命令参数无效');
  }
  const config = readManagedConfig(path);
  if (command !== 'serve') {
    console.log(JSON.stringify(await runManagedCommand(command, config, id)));
    return;
  }
  const app = await serveManaged(config, {
    onReady: (result) => console.log(JSON.stringify(result)),
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
}
// Node canonicalizes import.meta.url, while argv[1] may retain /var aliases or
// user-created symlinks. Compare the same filesystem identity on both sides.
let invokedAsMain = false;
try {
  invokedAsMain =
    Boolean(process.argv[1]) &&
    realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* A module imported by a runner without an on-disk entry is not main. */
}
if (invokedAsMain) {
  main().catch((error) => {
    const message =
      error instanceof ManagementError
        ? error.message
        : '服务器管理操作失败；现有数据和配置均已保留';
    console.log(
      JSON.stringify({ ok: false, error: { code: error.code ?? 'MANAGEMENT_FAILED', message } }),
    );
    process.exitCode = 1;
  });
}
