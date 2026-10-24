import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import {
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  existsSync,
  createReadStream,
} from 'node:fs';
import { readdir, readFile, stat, copyFile, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class ManagementError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ManagementError';
  }
}
const fail = (code, message) => {
  throw new ManagementError(code, message);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const backupID = /^glossa-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.sqlite$/;
export const databaseName = 'quiet-paper.sqlite';

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function fsyncFile(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function fsyncDirectory(path) {
  fsyncFile(path);
}
export function atomicJSON(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    fsyncFile(temporary);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
function regular(path, code = 'UNSAFE_PATH') {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(code, '文件必须是普通文件，不能是符号链接');
  return info;
}
function secureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail('UNSAFE_PATH', '数据与备份目录不能是符号链接');
  return realpathSync(path);
}
function validAbsolute(value) {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
}
function secret(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{24,4096}$/.test(value);
}
function origin(value) {
  try {
    const u = new URL(value);
    return (
      ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.origin === value
    );
  } catch {
    return false;
  }
}

export function validateManagedConfig(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input.version !== 1 ||
    !uuid.test(input.instanceId ?? '')
  )
    fail('INVALID_CONFIG', '服务器配置版本或实例标识无效');
  const host = input.host ?? '127.0.0.1',
    port = input.port ?? 8787;
  const backupIntervalHours = input.backupIntervalHours ?? 24,
    retentionCount = input.retentionCount ?? 14;
  if (
    typeof host !== 'string' ||
    !['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !secret(input.token) ||
    !secret(input.adminToken) ||
    input.token === input.adminToken ||
    !validAbsolute(input.dataDir) ||
    !validAbsolute(input.backupDir) ||
    (input.staticDir !== undefined && input.staticDir !== '' && !validAbsolute(input.staticDir)) ||
    !Array.isArray(input.allowedOrigins ?? []) ||
    !(input.allowedOrigins ?? []).every(origin) ||
    !Number.isFinite(backupIntervalHours) ||
    backupIntervalHours < 1 ||
    backupIntervalHours > 720 ||
    !Number.isInteger(retentionCount) ||
    retentionCount < 1 ||
    retentionCount > 365
  )
    fail('INVALID_CONFIG', '服务器地址、密钥、目录或备份策略无效');
  const dataDir = resolve(input.dataDir),
    backupDir = resolve(input.backupDir);
  if (dataDir === backupDir) fail('INVALID_CONFIG', '备份目录必须与数据库目录分开');
  const ai = input.ai ?? { enabled: false, endpoint: '', model: '', apiKey: '' };
  if (
    !ai ||
    typeof ai !== 'object' ||
    typeof ai.enabled !== 'boolean' ||
    !['endpoint', 'model', 'apiKey'].every((k) => ai[k] === undefined || typeof ai[k] === 'string')
  )
    fail('INVALID_CONFIG', 'AI 代理配置无效');
  if (ai.enabled) {
    let endpoint;
    try {
      endpoint = new URL(ai.endpoint);
    } catch {
      fail('INVALID_CONFIG', 'AI 服务地址无效');
    }
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.pathname.endsWith('/chat/completions') ||
      (endpoint.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) ||
      !ai.model?.trim() ||
      ai.model.length > 200 ||
      !ai.apiKey?.trim() ||
      /[\r\n\0]/.test(ai.apiKey)
    )
      fail('INVALID_CONFIG', 'AI 代理需要有效的 HTTPS 地址、模型及服务密钥');
  }
  return {
    version: 1,
    instanceId: input.instanceId,
    host,
    port,
    token: input.token,
    adminToken: input.adminToken,
    dataDir,
    staticDir: input.staticDir || undefined,
    backupDir,
    allowedOrigins: input.allowedOrigins ?? [],
    backupIntervalHours,
    retentionCount,
    ai: {
      enabled: ai.enabled,
      endpoint: ai.endpoint ?? '',
      model: ai.model ?? '',
      apiKey: ai.apiKey ?? '',
    },
  };
}

export function readManagedConfig(path) {
  if (!validAbsolute(path)) fail('INVALID_CONFIG', '配置文件路径必须是绝对路径');
  const info = regular(path, 'INVALID_CONFIG');
  if (
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    info.size > 1024 * 1024
  )
    fail('CONFIG_PERMISSIONS', '服务器配置含有密钥，文件权限必须为 600');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('INVALID_CONFIG', '服务器配置不是有效 JSON');
  }
  return validateManagedConfig(parsed);
}

/** A separate SQLite transaction is an OS-backed, crash-released lease. Every
 * server and restore operation cooperates; no stale-PID file can steal a lease. */
export function acquireDatabaseLease(dataDir) {
  const directory = secureDirectory(dataDir);
  const path = join(directory, '.glossa-lease.sqlite');
  if (existsSync(path)) regular(path);
  const archive = join(directory, databaseName);
  if (existsSync(archive)) regular(archive);
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(archive + suffix)) regular(archive + suffix);
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(
      'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;',
    );
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      db?.close();
    } catch {}
    if (/locked|busy/i.test(String(error)))
      fail('SERVICE_BUSY', '服务器数据库正由另一进程使用，请先停止服务');
    throw error;
  }
  let released = false;
  return {
    release() {
      if (!released) {
        released = true;
        try {
          db.exec('ROLLBACK');
        } finally {
          db.close();
        }
      }
    },
  };
}
export function leaseIsHeld(dataDir) {
  if (!existsSync(dataDir)) return false;
  try {
    const lease = acquireDatabaseLease(dataDir);
    lease.release();
    return false;
  } catch (error) {
    if (error.code === 'SERVICE_BUSY') return true;
    throw error;
  }
}
export function archiveProjects(db) {
  return db
    .prepare(
      `SELECT p.id,p.mode,count(o.id) AS operations,max(o.received_at) AS lastReceivedAt
    FROM projects p LEFT JOIN operations o ON p.id=o.project_id GROUP BY p.id ORDER BY p.id`,
    )
    .all()
    .map((row) => ({ ...row }));
}
export function verifyDatabase(path) {
  regular(path, 'BACKUP_INVALID');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare('PRAGMA quick_check').all();
    if (
      checks.length !== 1 ||
      Object.values(checks[0])[0] !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      fail('BACKUP_INVALID', '备份数据库完整性检查失败');
    const columns = db
      .prepare('PRAGMA table_info(operations)')
      .all()
      .map((row) => row.name);
    if (
      !['seq', 'project_id', 'id', 'envelope', 'received_at'].every((column) =>
        columns.includes(column),
      )
    )
      fail('BACKUP_INVALID', '备份不包含笺注操作归档');
    const projects = archiveProjects(db);
    return {
      projects: projects.length,
      operations: db.prepare('SELECT count(*) AS n FROM operations').get().n,
    };
  } finally {
    db.close();
  }
}
function normalizeSnapshot(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE;');
  } finally {
    db.close();
  }
}
function idPath(directory, id) {
  if (typeof id !== 'string' || !backupID.test(id) || basename(id) !== id)
    fail('BACKUP_INVALID', '备份标识无效');
  return join(directory, id);
}

export async function verifyBackup(backupDir, id) {
  const path = idPath(backupDir, id);
  try {
    const info = regular(path, 'BACKUP_INVALID');
    const manifestInfo = regular(path + '.manifest.json', 'BACKUP_INVALID');
    if (manifestInfo.size > 64 * 1024) fail('BACKUP_INVALID', '备份清单无效');
    const manifest = JSON.parse(await readFile(path + '.manifest.json', 'utf8'));
    if (
      manifest.format !== 'glossa-server-backup' ||
      manifest.version !== 1 ||
      manifest.id !== id ||
      !uuid.test(manifest.instanceId ?? '') ||
      !/^\d{4}-\d{2}-\d{2}T/.test(manifest.createdAt ?? '') ||
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      manifest.bytes !== info.size ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')
    )
      fail('BACKUP_INVALID', '备份清单与数据库不一致');
    const sha256 = await hashFile(path);
    if (sha256 !== manifest.sha256)
      fail('BACKUP_INVALID', '备份 SHA-256 校验失败，未修改当前数据库');
    const counts = verifyDatabase(path);
    if (counts.projects !== manifest.projects || counts.operations !== manifest.operations)
      fail('BACKUP_INVALID', '备份内容与清单计数不一致');
    return {
      id,
      createdAt: manifest.createdAt,
      bytes: manifest.bytes,
      sha256,
      verified: true,
      projects: counts.projects,
      operations: counts.operations,
      instanceId: manifest.instanceId,
      reason: manifest.reason ?? 'manual',
    };
  } catch (error) {
    if (error instanceof ManagementError) throw error;
    fail('BACKUP_INVALID', '备份缺失、损坏或无法读取，未修改当前数据库');
  }
}
export async function listBackups(backupDir) {
  let names;
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const result = [];
  const candidates = new Set(
    names
      .map((name) => (name.endsWith('.manifest.json') ? name.slice(0, -14) : name))
      .filter((name) => backupID.test(name)),
  );
  for (const id of candidates) {
    try {
      result.push(await verifyBackup(backupDir, id));
    } catch (error) {
      result.push({ id, createdAt: null, verified: false, error: error.message });
    }
  }
  return result.sort(
    (a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
      b.id.localeCompare(a.id),
  );
}

export class ArchiveManager {
  constructor({
    db,
    dataDir,
    backupDir,
    instanceId,
    backupIntervalHours = 24,
    retentionCount = 14,
    intervalMs,
    now = () => Date.now(),
    fault = () => {},
  }) {
    this.db = db;
    this.dataDir = dataDir;
    this.backupDir = secureDirectory(backupDir);
    this.instanceId = instanceId;
    this.retentionCount = retentionCount;
    this.intervalMs = intervalMs ?? backupIntervalHours * 3600_000;
    this.now = now;
    this.fault = fault;
    this.lastAt = null;
    this.lastError = null;
    this.nextAt = null;
    this.timer = null;
    this.inFlight = null;
    this.stopped = true;
  }
  async start() {
    const records = await listBackups(this.backupDir);
    this.lastAt = records.find((record) => record.verified)?.createdAt ?? null;
    this.stopped = false;
    this.schedule();
  }
  status() {
    return {
      lastAt: this.lastAt,
      nextAt: this.nextAt,
      lastError: this.lastError,
      intervalHours: this.intervalMs / 3600_000,
      retentionCount: this.retentionCount,
    };
  }
  schedule(retry = false) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const due = retry
      ? this.now() + Math.min(this.intervalMs, 15 * 60_000)
      : Math.max(
          this.now(),
          (this.lastAt ? Date.parse(this.lastAt) : this.now()) + this.intervalMs,
        );
    this.nextAt = new Date(due).toISOString();
    const fire = async () => {
      if (this.stopped) return;
      if (due > this.now()) {
        this.timer = setTimeout(fire, Math.max(1, Math.min(due - this.now(), 2_147_483_647)));
        this.timer.unref();
        return;
      }
      try {
        await this.create('automatic');
        this.schedule();
      } catch {
        this.schedule(true);
      }
    };
    this.timer = setTimeout(fire, Math.max(1, Math.min(due - this.now(), 2_147_483_647)));
    this.timer.unref();
  }
  async create(reason = 'manual', { retain = true } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performBackup(reason, retain).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  async performBackup(reason, retain) {
    const createdAt = new Date(
      Math.max(this.now(), this.lastAt ? Date.parse(this.lastAt) + 1 : 0),
    ).toISOString();
    const id = `glossa-${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
    const target = idPath(this.backupDir, id),
      temporary = target + '.' + randomUUID() + '.tmp';
    let committed = false;
    try {
      this.fault('before-backup');
      await sqliteBackup(this.db, temporary);
      chmodSync(temporary, 0o600);
      normalizeSnapshot(temporary);
      const counts = verifyDatabase(temporary);
      fsyncFile(temporary);
      const bytes = (await stat(temporary)).size;
      const sha256 = await hashFile(temporary);
      this.fault('before-backup-commit');
      renameSync(temporary, target);
      atomicJSON(target + '.manifest.json', {
        format: 'glossa-server-backup',
        version: 1,
        id,
        instanceId: this.instanceId,
        createdAt,
        bytes,
        sha256,
        ...counts,
        reason,
      });
      fsyncDirectory(this.backupDir);
      committed = true;
      const result = await verifyBackup(this.backupDir, id);
      this.lastAt = createdAt;
      this.lastError = null;
      if (retain) await this.prune();
      if (!this.stopped) this.schedule();
      return result;
    } catch (error) {
      this.lastError =
        error instanceof ManagementError ? error.message : '备份创建失败；现有数据库与备份均已保留';
      if (!committed) {
        try {
          await unlink(target);
        } catch {}
        try {
          await unlink(target + '.manifest.json');
        } catch {}
      }
      if (error instanceof ManagementError) throw error;
      fail('BACKUP_FAILED', this.lastError);
    } finally {
      for (const path of [temporary, temporary + '-wal', temporary + '-shm'])
        try {
          await unlink(path);
        } catch {}
    }
  }
  async prune() {
    const records = (await listBackups(this.backupDir)).filter((record) => record.verified);
    for (const record of records.slice(this.retentionCount)) {
      await unlink(idPath(this.backupDir, record.id) + '.manifest.json');
      await unlink(idPath(this.backupDir, record.id));
    }
    fsyncDirectory(this.backupDir);
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.nextAt = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }
}

export async function restoreArchive(config, id, { fault = () => {} } = {}) {
  let lease;
  try {
    lease = acquireDatabaseLease(config.dataDir);
  } catch (error) {
    if (error.code === 'SERVICE_BUSY')
      fail('RESTORE_SERVICE_RUNNING', '恢复前必须完全停止服务器；当前数据库未修改');
    throw error;
  }
  const database = join(config.dataDir, databaseName),
    temporary = database + '.restore-' + randomUUID(),
    rollback = database + '.rollback-' + randomUUID();
  let safety,
    installed = false,
    hadOriginal = false;
  try {
    const selected = await verifyBackup(config.backupDir, id);
    if (selected.instanceId !== config.instanceId)
      fail('BACKUP_INSTANCE_MISMATCH', '备份属于另一服务器实例，未修改当前数据库');
    // Copy first, then verify again at the destination to close backup-file races.
    await copyFile(idPath(config.backupDir, id), temporary);
    chmodSync(temporary, 0o600);
    fsyncFile(temporary);
    verifyDatabase(temporary);
    if ((await hashFile(temporary)) !== selected.sha256)
      fail('BACKUP_INVALID', '复制期间备份发生变化，未修改当前数据库');
    if (existsSync(database)) {
      regular(database);
      hadOriginal = true;
      const current = new DatabaseSync(database);
      try {
        const manager = new ArchiveManager({ db: current, ...config, fault });
        safety = await manager.create('before-restore', { retain: false });
        const checkpoint = current.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy !== 0) fail('SERVICE_BUSY', '数据库仍有活动连接，未执行恢复');
        current.exec('PRAGMA journal_mode=DELETE;');
      } finally {
        current.close();
      }
      await copyFile(database, rollback);
      chmodSync(rollback, 0o600);
      fsyncFile(rollback);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = database + suffix;
        if (existsSync(sidecar)) {
          regular(sidecar);
          unlinkSync(sidecar);
        }
      }
    }
    fault('before-restore-install');
    renameSync(temporary, database);
    installed = true;
    fault('after-restore-install');
    fsyncDirectory(config.dataDir);
    verifyDatabase(database);
    return { id, safetyBackupId: safety?.id ?? null, at: new Date().toISOString() };
  } catch (error) {
    if (installed) {
      try {
        if (hadOriginal) renameSync(rollback, database);
        else unlinkSync(database);
        fsyncDirectory(config.dataDir);
      } catch {
        fail(
          'RESTORE_ROLLBACK_FAILED',
          '恢复中断且回滚写入失败；恢复前安全快照仍在备份目录，请保持服务器停止',
        );
      }
    }
    if (error instanceof ManagementError) throw error;
    fail('RESTORE_FAILED', '恢复失败，当前数据库已保留，恢复前安全快照仍可用');
  } finally {
    for (const path of [temporary, rollback])
      try {
        unlinkSync(path);
      } catch {}
    lease.release();
  }
}
