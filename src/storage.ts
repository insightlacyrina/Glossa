import type { Point, Project } from './domain';

export type DraftStroke = {
  id?: string;
  projectId?: string;
  deviceId?: string;
  updatedAt?: number;
  noteId: string;
  pageId: string;
  points: Point[];
  color: string;
  width: number;
  layerId: string;
};
export type StoredWorkspace = {
  project: Project;
  draft?: DraftStroke | null;
  cursor?: number;
  syncIdentity?: string;
  epoch?: string;
};
export type DraftEntry = { key: string; draft: DraftStroke };
export type WorkspaceSaveOptions = {
  consumeDraft?: { key: string; expected: DraftStroke };
  expectedEpoch?: string | null;
};
export type WorkspaceRecovery = {
  format: 'quiet-paper-local-recovery';
  at: number;
  reason: string;
  workspace: StoredWorkspace;
};
export class WorkspaceChangedError extends Error {
  readonly code = 'WORKSPACE_CHANGED';
  constructor() {
    super('工程已在其他窗口恢复或切换；本窗口内容已保留为恢复副本，请导出后重新打开。');
  }
}
export const workspaceEpoch = (value: StoredWorkspace | undefined): string | null =>
  value ? (value.epoch ?? 'legacy') : null;
function recoveryKey() {
  return `recovery:${Date.now()}:${crypto.randomUUID()}`;
}
let database: Promise<IDBDatabase> | undefined;
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
function db(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('quiet-paper-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error('本地资料库被其他窗口占用'));
    };
  }));
}
export async function readLocal<T>(key: string): Promise<T | undefined> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('workspace', 'readonly');
    const req = tx.objectStore('workspace').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** Includes orphan checkpoints whose sessionStorage tab identity disappeared after a process restart. */
export async function listDrafts(): Promise<DraftEntry[]> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('workspace', 'readonly');
    const req = tx.objectStore('workspace').openCursor();
    const entries: DraftEntry[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const key = String(cursor.key),
        value = cursor.value as DraftStroke | undefined;
      if (
        (key === 'draft' || key.startsWith('draft:')) &&
        value &&
        typeof value.noteId === 'string' &&
        typeof value.pageId === 'string' &&
        Array.isArray(value.points) &&
        value.points.length
      )
        entries.push({ key, draft: value });
      cursor.continue();
    };
    tx.oncomplete = () => resolve(entries);
    tx.onerror = () => reject(tx.error ?? new Error('读取待恢复笔迹失败'));
    tx.onabort = () => reject(tx.error ?? new Error('读取待恢复笔迹中断'));
  });
}
/** The transaction completes before the UI can claim a durable save. */
export async function writeLocal(key: string, value: unknown): Promise<void> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('workspace', 'readwrite', { durability: 'strict' });
    tx.objectStore('workspace').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('本地保存失败'));
    tx.onabort = () => reject(tx.error ?? new Error('本地保存中断'));
  });
}
/** Keep immutable events from another open window instead of overwriting its journal. */
export async function saveWorkspace(
  value: StoredWorkspace,
  options: WorkspaceSaveOptions = {},
): Promise<Project> {
  if (
    options.consumeDraft &&
    !(options.consumeDraft.key === 'draft' || options.consumeDraft.key.startsWith('draft:'))
  )
    throw new Error('仅可消费笔迹检查点');
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('workspace', 'readwrite', { durability: 'strict' });
    const store = tx.objectStore('workspace');
    const req = store.get('current');
    let result = value.project;
    let failure: Error | undefined;
    req.onsuccess = () => {
      const previous = req.result as StoredWorkspace | undefined;
      const expected =
        options.expectedEpoch !== undefined ? options.expectedEpoch : (value.epoch ?? null);
      if (
        workspaceEpoch(previous) !== expected ||
        (previous && previous.project.id !== value.project.id)
      ) {
        // Commit this recovery copy while refusing to replace the newly selected workspace.
        store.put(
          {
            format: 'quiet-paper-local-recovery',
            at: Date.now(),
            reason: 'stale-window-save',
            workspace: value,
          } satisfies WorkspaceRecovery,
          recoveryKey(),
        );
        failure = new WorkspaceChangedError();
        return;
      }
      if (previous?.project.id === value.project.id) {
        const events = new Map(previous.project.operations.map((op) => [op.id, op]));
        for (const op of value.project.operations) {
          const existing = events.get(op.id);
          if (existing && canonical(existing) !== canonical(op)) {
            tx.abort();
            return;
          }
          events.set(op.id, op);
        }
        result = { ...value.project, operations: [...events.values()] };
      }
      store.put(
        { ...value, epoch: value.epoch ?? previous?.epoch ?? crypto.randomUUID(), project: result },
        'current',
      );
      if (options.consumeDraft) {
        const { key, expected } = options.consumeDraft;
        const checkpoint = store.get(key);
        // A newer gesture may already have replaced the checkpoint. Never consume that gesture.
        checkpoint.onsuccess = () => {
          if (canonical(checkpoint.result) === canonical(expected)) store.delete(key);
        };
      }
    };
    tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
    tx.onerror = () => reject(tx.error ?? new Error('保存失败'));
    tx.onabort = () => reject(tx.error ?? new Error('事件身份冲突，已保留原资料库'));
  });
}
/** Explicit restore is an atomic replacement, including same-project older snapshots. */
export async function replaceWorkspace(
  value: StoredWorkspace,
  expectedEpoch: string | null,
  localRecovery?: StoredWorkspace,
): Promise<StoredWorkspace> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('workspace', 'readwrite', { durability: 'strict' });
    const store = tx.objectStore('workspace');
    const request = store.get('current');
    const next: StoredWorkspace = {
      ...value,
      epoch: crypto.randomUUID(),
      cursor: value.cursor ?? 0,
    };
    let failure: Error | undefined;
    request.onsuccess = () => {
      const previous = request.result as StoredWorkspace | undefined;
      if (workspaceEpoch(previous) !== expectedEpoch) {
        if (localRecovery)
          store.put(
            {
              format: 'quiet-paper-local-recovery',
              at: Date.now(),
              reason: 'stale-window-restore',
              workspace: localRecovery,
            } satisfies WorkspaceRecovery,
            recoveryKey(),
          );
        failure = new WorkspaceChangedError();
        return;
      }
      if (previous)
        store.put(
          {
            format: 'quiet-paper-local-recovery',
            at: Date.now(),
            reason: 'before-restore',
            workspace: previous,
          } satisfies WorkspaceRecovery,
          recoveryKey(),
        );
      if (localRecovery && canonical(localRecovery.project) !== canonical(previous?.project))
        store.put(
          {
            format: 'quiet-paper-local-recovery',
            at: Date.now(),
            reason: 'unsaved-before-restore',
            workspace: localRecovery,
          } satisfies WorkspaceRecovery,
          recoveryKey(),
        );
      store.put(next, 'current');
      // Old requests cannot re-enable this connection: the caller also invalidates its session.
      store.put(null, 'sync-config');
    };
    tx.oncomplete = () => (failure ? reject(failure) : resolve(next));
    tx.onerror = () => reject(tx.error ?? new Error('工程恢复失败，原工程未被替换'));
    tx.onabort = () => reject(tx.error ?? new Error('工程恢复事务中断，原工程未被替换'));
  });
}
export async function listRecoveries(): Promise<{ key: string; recovery: WorkspaceRecovery }[]> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('workspace', 'readonly'),
      request = tx.objectStore('workspace').openCursor();
    const result: { key: string; recovery: WorkspaceRecovery }[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        if (
          String(cursor.key).startsWith('recovery:') &&
          cursor.value?.format === 'quiet-paper-local-recovery'
        )
          result.push({ key: String(cursor.key), recovery: cursor.value });
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(result.sort((a, b) => b.recovery.at - a.recovery.at));
    tx.onerror = () => reject(tx.error ?? new Error('无法读取恢复副本'));
  });
}
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
