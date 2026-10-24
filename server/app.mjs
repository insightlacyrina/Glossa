import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import {
  acquireDatabaseLease,
  ArchiveManager,
  archiveProjects,
  listBackups,
  verifyBackup,
} from './management.mjs';
import { createAIProxy } from './ai-proxy.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
const idPattern = /^[\w.:-]{1,180}$/;

/** An append-only operation archive. No note contents are interpreted by this server. */
export function createSyncServer({
  dataDir,
  token,
  staticDir,
  allowedOrigins = [],
  maxBodyBytes = 32 * 1024 * 1024,
  maxPullBytes = 24 * 1024 * 1024,
  lease: suppliedLease,
  management: managementConfig,
  aiProxy: suppliedAIProxy,
  ai,
} = {}) {
  if (typeof token !== 'string' || token.length < 24)
    throw new Error('GLOSSA_TOKEN must contain at least 24 characters');
  if (!dataDir) throw new Error('dataDir is required');
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes <= 0 ||
    !Number.isSafeInteger(maxPullBytes) ||
    maxPullBytes <= 0
  )
    throw new Error('Sync byte limits must be positive safe integers');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lease = suppliedLease ?? acquireDatabaseLease(dataDir);
  let db;
  try {
    db = new DatabaseSync(resolve(dataDir, 'quiet-paper.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, mode TEXT NOT NULL, key_id TEXT);
    CREATE TABLE IF NOT EXISTS operations (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, envelope TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(project_id,id));
    CREATE INDEX IF NOT EXISTS project_seq ON operations(project_id,seq);`);
  } catch (error) {
    try {
      db?.close();
    } finally {
      lease.release();
    }
    throw error;
  }
  const getProject = db.prepare('SELECT mode,key_id FROM projects WHERE id = ?');
  const createProject = db.prepare('INSERT INTO projects(id,mode,key_id) VALUES (?,?,?)');
  const getOp = db.prepare('SELECT envelope FROM operations WHERE project_id = ? AND id = ?');
  const insertOp = db.prepare(
    'INSERT INTO operations(project_id,id,envelope,received_at) VALUES (?,?,?,?)',
  );
  const pull = db.prepare(
    'SELECT seq,envelope FROM operations WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT 1001',
  );
  const lastSeq = db.prepare(
    'SELECT coalesce(max(seq),0) AS seq FROM operations WHERE project_id = ?',
  );
  const tokenHash = createHash('sha256').update(token).digest();
  const staticRoot = staticDir ? resolve(staticDir) : null;
  // Deliberately not restored from SQLite: a restart must invalidate acknowledgements of an older archive.
  const generation = randomUUID();
  let aiProxy;
  try {
    aiProxy = suppliedAIProxy ?? createAIProxy(ai ?? {});
  } catch (error) {
    db.close();
    lease.release();
    throw error;
  }
  const startedAt = new Date().toISOString();
  let manager = null;
  let adminHash = null;
  if (managementConfig) {
    if (
      typeof managementConfig.adminToken !== 'string' ||
      managementConfig.adminToken.length < 24 ||
      managementConfig.adminToken === token
    ) {
      db.close();
      lease.release();
      throw new Error('A separate admin token is required');
    }
    try {
      manager = new ArchiveManager({ db, dataDir, ...managementConfig });
    } catch (error) {
      aiProxy.close();
      db.close();
      lease.release();
      throw error;
    }
    adminHash = createHash('sha256').update(managementConfig.adminToken).digest();
  }
  let managerReady = manager ? manager.start() : Promise.resolve();
  managerReady = managerReady.catch(() => {
    if (manager) manager.lastError = '无法读取备份目录；自动备份尚未启动';
  });
  function isLoopback(req) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  }
  function authorized(req, expectedHash) {
    const auth = req.headers.authorization ?? '';
    return timingSafeEqual(
      expectedHash,
      createHash('sha256')
        .update(auth.startsWith('Bearer ') ? auth.slice(7) : '')
        .digest(),
    );
  }
  function managementStatus() {
    return {
      running: true,
      instanceId: managementConfig.instanceId,
      pid: process.pid,
      startedAt,
      generation,
      url: managementConfig.url,
      projects: db.prepare('SELECT count(*) AS n FROM projects').get().n,
      operations: db.prepare('SELECT count(*) AS n FROM operations').get().n,
      backup: manager.status(),
      ai: {
        enabled: aiProxy.status().aiProxyAvailable,
        configured: aiProxy.status().aiProxyAvailable,
      },
    };
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }
  function validateEnvelope(op, mode) {
    if (
      !op ||
      typeof op !== 'object' ||
      typeof op.id !== 'string' ||
      !idPattern.test(op.id) ||
      op.mode !== mode
    )
      return false;
    if (mode === 'plain')
      return op.payload && typeof op.payload === 'object' && op.payload.id === op.id;
    if (mode === 'e2ee')
      return (
        typeof op.iv === 'string' &&
        /^[A-Za-z0-9+/]{16}$/.test(op.iv) &&
        typeof op.data === 'string' &&
        op.data.length >= 24 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(op.data) &&
        typeof op.fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(op.fingerprint) &&
        !('payload' in op)
      );
    return false;
  }

  const server = createServer(async (req, res) => {
    try {
      // Admin access uses the actual peer address and a separate credential.
      // Browser requests, including Origin:null, cannot enter this branch.
      if (req.url?.startsWith('/api/admin/')) {
        if (!manager) return send(res, 404, { error: 'NOT_FOUND' });
        if (!isLoopback(req) || req.headers.origin !== undefined)
          return send(res, 403, { error: 'ADMIN_LOCAL_ONLY' });
        if (!authorized(req, adminHash)) return send(res, 401, { error: 'UNAUTHORIZED' });
        await managerReady;
        if (req.method === 'GET' && req.url === '/api/admin/status')
          return send(res, 200, { ok: true, ...managementStatus() });
        if (req.method === 'GET' && req.url === '/api/admin/projects')
          return send(res, 200, { ok: true, projects: archiveProjects(db) });
        if (req.method === 'GET' && req.url === '/api/admin/backups')
          return send(res, 200, { ok: true, backups: await listBackups(manager.backupDir) });
        if (req.method === 'POST' && req.url === '/api/admin/backup')
          return send(res, 200, { ok: true, backup: await manager.create() });
        if (req.method === 'POST' && req.url === '/api/admin/backups/verify') {
          if (!req.headers['content-type']?.startsWith('application/json'))
            return send(res, 415, { error: 'JSON_REQUIRED' });
          let bytes = 0;
          const chunks = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 4096) return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
            chunks.push(chunk);
          }
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return send(res, 400, { error: 'INVALID_JSON' });
          }
          return send(res, 200, {
            ok: true,
            backup: await verifyBackup(manager.backupDir, body?.id),
          });
        }
        return send(res, 404, { error: 'NOT_FOUND' });
      }
      const origin = req.headers.origin;
      const sameOrigin =
        origin && origin === `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      const originAllowed = !origin || sameOrigin || allowedOrigins.includes(origin);
      if (origin && originAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.url?.startsWith('/api/') && !originAllowed)
        return send(res, 403, { error: 'ORIGIN_DENIED' });
      if (req.method === 'OPTIONS') {
        if (!originAllowed) return send(res, 403, { error: 'ORIGIN_DENIED' });
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
      if (req.url === '/health' && req.method === 'GET')
        return send(res, 200, { ok: true, service: 'glossa-sync', protocol: 1 });
      if (req.url?.startsWith('/api/')) {
        const auth = req.headers.authorization || '';
        const suppliedHash = createHash('sha256')
          .update(auth.startsWith('Bearer ') ? auth.slice(7) : '')
          .digest();
        if (!timingSafeEqual(tokenHash, suppliedHash))
          return send(res, 401, { error: 'UNAUTHORIZED' });
        if (req.url === '/api/status' && req.method === 'GET') {
          const count = db.prepare('SELECT count(*) AS total FROM operations').get();
          return send(res, 200, {
            protocol: 1,
            generation,
            operations: count.total,
            persistence: 'sqlite-wal-full',
            serverCanReadPlain: true,
            serverCanDecryptE2EE: false,
            aiProxyAvailable: aiProxy.status().aiProxyAvailable,
            aiTemporaryPlaintextAccess: aiProxy.status().aiProxyAvailable,
          });
        }
        if (req.url?.startsWith('/api/ai/')) {
          await aiProxy.handle(req, res, { tokenAuthenticated: true });
          return;
        }
        if (req.url !== '/api/sync' || req.method !== 'POST')
          return send(res, 404, { error: 'NOT_FOUND' });
        if (!req.headers['content-type']?.startsWith('application/json'))
          return send(res, 415, { error: 'JSON_REQUIRED' });
        if (Number(req.headers['content-length']) > maxBodyBytes) {
          req.resume();
          return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
        }
        let bytes = 0;
        let tooLarge = false;
        const chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > maxBodyBytes) {
            tooLarge = true;
            chunks.length = 0;
          }
          if (!tooLarge) chunks.push(chunk);
        }
        if (tooLarge) return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, { error: 'INVALID_JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return send(res, 400, { error: 'INVALID_SYNC_REQUEST' });
        const { projectId, mode, keyId = null, ops, cursor } = body;
        if (body.generation !== undefined && body.generation !== generation)
          return send(res, 409, { error: 'SERVER_GENERATION_CHANGED', generation });
        if (
          typeof projectId !== 'string' ||
          !idPattern.test(projectId) ||
          !['plain', 'e2ee'].includes(mode) ||
          !Array.isArray(ops) ||
          ops.length > 5000 ||
          !Number.isSafeInteger(cursor) ||
          cursor < 0 ||
          (mode === 'e2ee'
            ? typeof keyId !== 'string' || !/^[a-f0-9]{64}$/.test(keyId)
            : keyId !== null) ||
          !ops.every((op) => validateEnvelope(op, mode))
        )
          return send(res, 400, { error: 'INVALID_SYNC_REQUEST' });
        const project = getProject.get(projectId);
        if (project && (project.mode !== mode || project.key_id !== keyId))
          return send(res, 409, { error: 'PROJECT_ENCRYPTION_MISMATCH' });
        const highest = Number(lastSeq.get(projectId).seq);
        if (cursor > highest)
          return send(res, 409, { error: 'CURSOR_AHEAD', serverCursor: highest, generation });
        const encodings = [];
        const inBatch = new Map();
        for (const op of ops) {
          const encoded = JSON.stringify(op);
          const prior = inBatch.get(op.id) || getOp.get(projectId, op.id)?.envelope;
          // HMAC fingerprints let randomized encrypted retries remain idempotent without exposing a plaintext hash.
          const same =
            prior &&
            (mode === 'e2ee'
              ? JSON.parse(prior).fingerprint === op.fingerprint
              : prior === encoded);
          if (prior && !same)
            return send(res, 409, { error: 'OP_ID_COLLISION', operationId: op.id });
          inBatch.set(op.id, encoded);
          encodings.push([op.id, encoded, !!prior]);
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!project) createProject.run(projectId, mode, keyId);
          for (const [id, encoded, exists] of encodings)
            if (!exists) insertOp.run(projectId, id, encoded, new Date().toISOString());
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        const accepted = ops.map((op) => op.id),
          page = [];
        let pageCursor = cursor,
          hasMore = false;
        let pageBytes = Buffer.byteLength(
          JSON.stringify({
            protocol: 1,
            generation,
            ops: [],
            cursor: Number.MAX_SAFE_INTEGER,
            hasMore: false,
            accepted,
          }),
        );
        // Iterate rather than loading 1001 potentially large image envelopes into a JS array.
        for (const row of pull.iterate(projectId, cursor)) {
          const size = Buffer.byteLength(row.envelope) + (page.length ? 1 : 0);
          if (page.length && (page.length >= 1000 || pageBytes + size > maxPullBytes)) {
            hasMore = true;
            break;
          }
          // One already archived operation may exceed a configured soft pull budget. Send it whole
          // on its own rather than dropping its payload or returning a cursor that never advances.
          page.push(JSON.parse(row.envelope));
          pageCursor = Number(row.seq);
          pageBytes += size;
        }
        return send(res, 200, {
          protocol: 1,
          generation,
          ops: page,
          cursor: pageCursor,
          hasMore,
          accepted,
        });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (staticRoot) {
        let requestPath;
        try {
          requestPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
        } catch {
          return send(res, 400, { error: 'INVALID_PATH' });
        }
        let file = resolve(staticRoot, `.${requestPath}`);
        if (file !== staticRoot && !file.startsWith(staticRoot + sep))
          return send(res, 403, { error: 'FORBIDDEN' });
        if (requestPath === '/' || !extname(requestPath)) file = resolve(staticRoot, 'index.html');
        try {
          const realFile = realpathSync(file);
          if (!realFile.startsWith(realpathSync(staticRoot) + sep) || !statSync(file).isFile())
            return send(res, 404, { error: 'NOT_FOUND' });
          res.writeHead(200, {
            'Content-Type': MIME[extname(file)] || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control':
              extname(file) === '.html' || file.endsWith('sw.js')
                ? 'no-cache'
                : 'public, max-age=3600',
          });
          return res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
        } catch {
          return send(res, 404, { error: 'NOT_FOUND' });
        }
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (req.url?.startsWith('/api/admin/') && error?.code) {
        if (!res.headersSent) send(res, 400, { error: error.code, message: error.message });
        else res.end();
        return;
      }
      if (!res.headersSent) send(res, 500, { error: 'INTERNAL_ERROR' });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  let closing;
  return {
    server,
    db,
    generation,
    management: manager,
    close: () =>
      (closing ??= (async () => {
        aiProxy.close();
        const serverClosed = new Promise((accept, reject) => {
          server.close((error) =>
            error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : accept(),
          );
          server.closeIdleConnections();
        });
        await managerReady;
        await manager?.close();
        await serverClosed;
        try {
          db.close();
        } finally {
          lease.release();
        }
      })()),
  };
}
