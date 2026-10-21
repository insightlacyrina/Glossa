/** Mac self-hosted sync transports immutable operations. Content merging belongs to the domain. */
export type SyncOperation = { id: string; [key: string]: unknown };
export type SyncMode = 'plain' | 'e2ee';
export interface SyncConfig {
  url: string;
  token: string;
  projectId: string;
  mode: SyncMode;
  /** Kept on the client; never included in HTTP requests. */
  passphrase?: string;
}
export type WireEnvelope =
  | { id: string; mode: 'plain'; payload: SyncOperation }
  | { id: string; mode: 'e2ee'; iv: string; data: string; fingerprint: string };
export interface SyncResult {
  operations: SyncOperation[];
  cursor: number;
  acknowledgedIds: string[];
  serverGeneration: string;
}

export class SyncProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly serverGeneration?: string,
    public readonly serverCursor?: number,
  ) {
    super(message);
    this.name = 'SyncProtocolError';
  }
}
const validGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.:-]{1,180}$/.test(value);
function protocolError(result: Record<string, unknown>, status: number) {
  const code = typeof result.error === 'string' ? result.error : 'UNKNOWN_ERROR';
  const messages: Record<string, string> = {
    UNAUTHORIZED: '同步令牌无效',
    PROJECT_ENCRYPTION_MISMATCH: '工程加密模式或口令不匹配',
    CURSOR_AHEAD: '服务器备份早于本地同步记录，将重新校验并补齐本地操作',
    SERVER_GENERATION_CHANGED: '同步服务器已重启，将重新校验并补齐本地操作',
    OP_ID_COLLISION: '操作身份冲突，已停止同步以保护数据',
    ORIGIN_DENIED: '服务器尚未允许此客户端来源',
  };
  return new SyncProtocolError(
    code,
    messages[code] || `同步失败 (${status}): ${code}`,
    validGeneration(result.generation) ? result.generation : undefined,
    typeof result.serverCursor === 'number' && Number.isSafeInteger(result.serverCursor)
      ? result.serverCursor
      : undefined,
  );
}
function validateConfig(config: SyncConfig) {
  if (!config.url || !config.token || !config.projectId)
    throw new Error('请填写同步服务器、访问令牌与工程标识');
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('同步服务器地址无效');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('远端同步必须使用 HTTPS；本机开发可以使用 HTTP');
}
async function readServerGeneration(config: SyncConfig): Promise<string> {
  validateConfig(config);
  const response = await fetch(config.url.replace(/\/$/, '') + '/api/status', {
    headers: { Authorization: 'Bearer ' + config.token },
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json();
  if (!response.ok) throw protocolError(result, response.status);
  if (result.protocol !== 1 || !validGeneration(result.generation))
    throw new SyncProtocolError(
      'INVALID_RESPONSE',
      '同步服务器缺少有效恢复世代标识，未修改本地数据',
    );
  return result.generation;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const MAX_SYNC_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_SYNC_REQUEST_OPERATIONS = 500;
const keyCache = new Map<string, Promise<{ aes: CryptoKey; hmac: CryptoKey; keyId: string }>>();

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function unbase64(value: string) {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map((item) => canonical(item ?? null)).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  );
}
function requireCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error('加密同步需要 HTTPS 或本机安全上下文');
  return globalThis.crypto.subtle;
}
async function keys(config: SyncConfig) {
  if (!config.passphrase || config.passphrase.length < 12)
    throw new Error('端到端加密口令至少需要 12 个字符');
  const cacheKey = config.projectId + '\0' + config.passphrase;
  if (!keyCache.has(cacheKey))
    keyCache.set(
      cacheKey,
      (async () => {
        const subtle = requireCrypto();
        const material = await subtle.importKey(
          'raw',
          encoder.encode(config.passphrase!),
          'PBKDF2',
          false,
          ['deriveBits'],
        );
        const bits = await subtle.deriveBits(
          {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: encoder.encode('quiet-paper-sync-v1:' + config.projectId),
            iterations: 310_000,
          },
          material,
          512,
        );
        const aes = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, [
          'encrypt',
          'decrypt',
        ]);
        const hmac = await subtle.importKey(
          'raw',
          bits.slice(32),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const keyId = hex(await subtle.digest('SHA-256', bits));
        return { aes, hmac, keyId };
      })(),
    );
  return keyCache.get(cacheKey)!;
}
export function clearEncryptionKeyCache() {
  keyCache.clear();
}

export async function encodeOperation(
  config: SyncConfig,
  operation: SyncOperation,
): Promise<WireEnvelope> {
  if (config.mode === 'plain')
    return {
      id: operation.id,
      mode: 'plain',
      payload: JSON.parse(canonical(operation)) as SyncOperation,
    };
  const subtle = requireCrypto();
  const { aes, hmac } = await keys(config);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(canonical(operation));
  const aad = encoder.encode(config.projectId + '\0' + operation.id);
  const fingerprint = hex(await subtle.sign('HMAC', hmac, plaintext));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    aes,
    plaintext,
  );
  return {
    id: operation.id,
    mode: 'e2ee',
    iv: base64(iv),
    data: base64(new Uint8Array(ciphertext)),
    fingerprint,
  };
}

export async function decodeOperation(
  config: SyncConfig,
  envelope: WireEnvelope,
): Promise<SyncOperation> {
  if (envelope.mode !== config.mode) throw new Error('同步加密模式不匹配；已停止同步');
  if (envelope.mode === 'plain') {
    if (envelope.payload?.id !== envelope.id) throw new Error('同步操作身份不一致');
    return envelope.payload;
  }
  const { aes, hmac } = await keys(config);
  try {
    const plaintext = await requireCrypto().decrypt(
      {
        name: 'AES-GCM',
        iv: unbase64(envelope.iv),
        additionalData: encoder.encode(config.projectId + '\0' + envelope.id),
      },
      aes,
      unbase64(envelope.data),
    );
    const fingerprint = hex(await requireCrypto().sign('HMAC', hmac, plaintext));
    if (fingerprint !== envelope.fingerprint) throw new Error('fingerprint');
    const operation = JSON.parse(decoder.decode(plaintext)) as SyncOperation;
    if (!operation || operation.id !== envelope.id) throw new Error('identity');
    return operation;
  } catch {
    throw new Error('加密数据验证失败；请检查口令或备份完整性');
  }
}

/** Count the complete UTF-8 JSON request, including separators and worst-case cursor digits. */
async function* uploadBatches(
  config: SyncConfig,
  operations: SyncOperation[],
  keyId: string | null,
): AsyncGenerator<WireEnvelope[]> {
  const overhead = encoder.encode(
    JSON.stringify({
      projectId: config.projectId,
      mode: config.mode,
      keyId,
      ops: [],
      cursor: Number.MAX_SAFE_INTEGER,
      generation: '0'.repeat(180),
    }),
  ).byteLength;
  if (overhead > MAX_SYNC_REQUEST_BYTES)
    throw new Error('工程标识超过单次同步容量；本地数据和待同步队列已保留');
  let batch: WireEnvelope[] = [],
    bytes = overhead;
  for (const operation of operations) {
    const envelope = await encodeOperation(config, operation);
    const size = encoder.encode(JSON.stringify(envelope)).byteLength;
    if (overhead + size > MAX_SYNC_REQUEST_BYTES)
      throw new Error(
        `单个操作 ${operation.id} 超过 24 MiB 同步容量；原始内容及待同步队列已保留，请导出完整工程`,
      );
    if (
      batch.length &&
      (batch.length >= MAX_SYNC_REQUEST_OPERATIONS || bytes + 1 + size > MAX_SYNC_REQUEST_BYTES)
    ) {
      yield batch;
      batch = [];
      bytes = overhead;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(envelope);
  }
  if (batch.length || !operations.length) yield batch;
}

/** Upload pending immutable operations; server idempotence makes interrupted retries safe. */
export async function syncOperations(
  config: SyncConfig,
  operations: SyncOperation[],
  cursor = 0,
  expectedGeneration?: string,
): Promise<SyncResult> {
  validateConfig(config);
  const encryptedKeys = config.mode === 'e2ee' ? await keys(config) : null;
  const received = new Map<string, SyncOperation>();
  let currentCursor = cursor;
  let serverGeneration = expectedGeneration;
  async function uploadAndDrain(chunk: WireEnvelope[]): Promise<void> {
    let hasMore = true;
    let uploaded = false;
    while (hasMore) {
      const pending = uploaded ? [] : chunk;
      const response = await fetch(config.url.replace(/\/$/, '') + '/api/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: config.projectId,
          mode: config.mode,
          keyId: encryptedKeys?.keyId ?? null,
          ops: pending,
          cursor: currentCursor,
          generation: serverGeneration,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (response.status === 413) {
        // A reverse proxy may send HTML rather than our JSON error. Do not parse or acknowledge it.
        await response.body?.cancel();
        if (pending.length > 1) {
          const middle = Math.ceil(pending.length / 2);
          await uploadAndDrain(pending.slice(0, middle));
          await uploadAndDrain(pending.slice(middle));
          return;
        }
        if (pending.length === 1)
          throw new Error(
            `单个操作 ${pending[0].id} 超过服务器接收容量；原始内容及待同步队列已保留`,
          );
        throw new Error('服务器接收容量不足以容纳同步请求；本地数据和待同步队列已保留');
      }
      const result = await response.json();
      if (!response.ok) {
        throw protocolError(result, response.status);
      }
      if (!validGeneration(result.generation))
        throw new SyncProtocolError(
          'INVALID_RESPONSE',
          '同步服务器缺少有效恢复世代标识，未修改本地数据',
        );
      if (serverGeneration && serverGeneration !== result.generation)
        throw new SyncProtocolError(
          'SERVER_GENERATION_CHANGED',
          '同步服务器已重启，将重新校验并补齐本地操作',
          result.generation,
        );
      serverGeneration = result.generation;
      if (
        !Array.isArray(result.ops) ||
        !Number.isSafeInteger(result.cursor) ||
        result.cursor < currentCursor ||
        typeof result.hasMore !== 'boolean'
      )
        throw new Error('同步服务器响应无效');
      for (const envelope of result.ops as WireEnvelope[]) {
        const operation = await decodeOperation(config, envelope);
        received.set(operation.id, operation);
      }
      if (result.hasMore && result.cursor === currentCursor) throw new Error('同步游标未前进');
      currentCursor = result.cursor;
      hasMore = result.hasMore;
      uploaded = true;
    }
  }
  for await (const batch of uploadBatches(config, operations, encryptedKeys?.keyId ?? null))
    await uploadAndDrain(batch);
  return {
    operations: [...received.values()],
    cursor: currentCursor,
    acknowledgedIds: [...new Set([...operations.map((op) => op.id), ...received.keys()])],
    serverGeneration: serverGeneration!,
  };
}

export interface AutoSyncOptions {
  config: SyncConfig | (() => SyncConfig);
  getOperations: () => SyncOperation[] | Promise<SyncOperation[]>;
  getCursor: () => number | Promise<number>;
  /** This callback MUST durably store the received operations before resolving. */
  applyRemote: (operations: SyncOperation[]) => void | Promise<void>;
  setCursor: (cursor: number) => void | Promise<void>;
  /** Durable acknowledgements MUST be scoped to this identity, including the server's boot generation. */
  getAcknowledgedIds?: (identity: string) => string[] | Promise<string[]>;
  setAcknowledgedIds?: (identity: string, ids: string[]) => void | Promise<void>;
  onStatus?: (status: 'syncing' | 'synced' | 'offline' | 'error', error?: string) => void;
  intervalMs?: number;
}
/** Recovery requires no server-side session: retry the durable journal whenever connectivity returns. */
export function startAutoSync(options: AutoSyncOptions) {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const acknowledged = new Map<string, Set<string>>();
  const syncNow = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      options.onStatus?.('syncing');
      try {
        const config = typeof options.config === 'function' ? options.config() : options.config;
        const keyId = config.mode === 'e2ee' ? (await keys(config)).keyId : 'plain';
        let fullReplay = false,
          lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          const generation = await readServerGeneration(config);
          if (stopped) return;
          const identity = `${config.url.replace(/\/$/, '')}|${config.projectId}|${config.mode}|${keyId}|${generation}`;
          if (!acknowledged.has(identity))
            acknowledged.set(
              identity,
              new Set((await options.getAcknowledgedIds?.(identity)) ?? []),
            );
          const known = acknowledged.get(identity)!;
          const all = await options.getOperations();
          const replay = fullReplay || known.size === 0;
          const pending = replay ? all : all.filter((op) => !known.has(op.id));
          const fromCursor = replay ? 0 : await options.getCursor();
          if (stopped) return;
          let result: SyncResult;
          try {
            result = await syncOperations(config, pending, fromCursor, generation);
          } catch (error) {
            if (
              error instanceof SyncProtocolError &&
              ['CURSOR_AHEAD', 'SERVER_GENERATION_CHANGED'].includes(error.code)
            ) {
              fullReplay = true;
              lastError = error;
              continue;
            }
            throw error;
          }
          if (stopped) return;
          await options.applyRemote(result.operations);
          await options.setCursor(result.cursor);
          for (const id of result.acknowledgedIds) known.add(id);
          await options.setAcknowledgedIds?.(identity, [...known]);
          options.onStatus?.('synced');
          return;
        }
        throw lastError ?? new Error('服务器持续重启，未确认操作仍保留，稍后自动重试');
      } catch (error) {
        options.onStatus?.(
          typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error',
          error instanceof Error ? error.message : String(error),
        );
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const timer = setInterval(syncNow, options.intervalMs ?? 8_000);
  const online = () => {
    void syncNow();
  };
  globalThis.addEventListener?.('online', online);
  void syncNow();
  return {
    syncNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      globalThis.removeEventListener?.('online', online);
    },
  };
}
