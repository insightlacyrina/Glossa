import { useCallback, useEffect, useRef, useState } from 'react';
import { NotebookEngine, type Point, type Project, type Role } from './domain';
import { seedWorkspace } from './bootstrap';
import {
  readLocal,
  requestPersistentStorage,
  saveWorkspace,
  replaceWorkspace,
  writeLocal,
  listDrafts,
  listRecoveries,
  workspaceEpoch,
  WorkspaceChangedError,
  type DraftStroke,
  type StoredWorkspace,
  type DraftEntry,
  type WorkspaceSaveOptions,
  type WorkspaceRecovery,
} from './storage';
import {
  IncrementalProcessor,
  type PipelineStatuses,
  type RecognitionResult,
  type ExternalAIConfig,
} from './automation';
import { createReviewCard, touchReviewCard, type ReviewCard } from './review';
import { startAutoSync, type SyncConfig, type SyncOperation } from './sync';
import { atomicAction, blockContentModifiedAt, SyncSessionGuard } from './workspaceSafety';

export const role: Role =
  window.QuietPaperNative?.getRole() ??
  (import.meta.env.DEV &&
  new URLSearchParams(location.search).get('device') !== 'mac' &&
  new URLSearchParams(location.search).get('device') !== 'phone'
    ? 'tablet'
    : new URLSearchParams(location.search).get('device') === 'phone' && import.meta.env.DEV
      ? 'phone'
      : 'mac');
function deviceIdentity() {
  const key = 'quiet-paper-device';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return window.QuietPaperNative?.getDeviceId() ?? id;
}
export const installationId = deviceIdentity();
// A vector-clock writer has exactly one live producer. Reloads and duplicated tabs get new writers.
const writerId = `${installationId}:writer:${crypto.randomUUID()}`;
const draftKey = `draft:${writerId}`;
export function useWorkspace() {
  const engineRef = useRef<NotebookEngine | null>(null);
  const epochRef = useRef('');
  const stale = useRef(false);
  const switching = useRef(false);
  const [version, setVersion] = useState(0),
    [ready, setReady] = useState(false);
  const [processorEpoch, setProcessorEpoch] = useState('');
  const [saveState, setSaveState] = useState('正在打开'),
    [error, setError] = useState(''),
    [persistent, setPersistent] = useState(false);
  const [statuses, setStatuses] = useState<PipelineStatuses>(),
    [syncState, setSyncState] = useState('未连接'),
    [syncError, setSyncError] = useState('');
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(null),
    [provider, setProvider] = useState<ExternalAIConfig>();
  const configRef = useRef<SyncConfig | null>(null);
  const [pendingDrafts, setPendingDrafts] = useState<DraftEntry[]>([]);
  const [recoverySnapshots, setRecoverySnapshots] = useState<
    { key: string; recovery: WorkspaceRecovery }[]
  >([]);
  const queue = useRef<Promise<void>>(Promise.resolve()),
    cursor = useRef(0),
    draft = useRef<DraftStroke | null>(null);
  const channel = useRef<BroadcastChannel | null>(null),
    syncHandle = useRef<ReturnType<typeof startAutoSync> | null>(null),
    processor = useRef<IncrementalProcessor | null>(null);
  const syncGuard = useRef(new SyncSessionGuard());
  const redraw = () => setVersion((v) => v + 1);
  const connectionIdentity = (config: SyncConfig | null) =>
    config ? `${config.url}|${config.projectId}|${config.mode}` : '';
  function invalidateSync() {
    syncGuard.current.invalidate();
    syncHandle.current?.stop();
    syncHandle.current = null;
  }
  function localSnapshot(): StoredWorkspace | undefined {
    const engine = engineRef.current;
    return engine
      ? {
          project: structuredClone(engine.project),
          epoch: epochRef.current,
          draft: draft.current ? structuredClone(draft.current) : null,
          cursor: cursor.current,
          syncIdentity: connectionIdentity(configRef.current),
        }
      : undefined;
  }
  async function refreshRecoveries() {
    const entries = await listRecoveries();
    setRecoverySnapshots(entries);
    return entries;
  }
  function markStale(message = '工程已在其他窗口恢复或切换；本窗口停止写入，原内容保留供导出。') {
    if (!stale.current) {
      stale.current = true;
      invalidateSync();
      processor.current?.dispose();
      const snapshot = localSnapshot();
      if (snapshot)
        void writeLocal(`recovery:${Date.now()}:${crypto.randomUUID()}`, {
          format: 'quiet-paper-local-recovery',
          at: Date.now(),
          reason: 'workspace-replaced-in-other-window',
          workspace: snapshot,
        } satisfies WorkspaceRecovery)
          .then(refreshRecoveries)
          .catch(() => {});
    }
    setSaveState('工程已切换 · 本窗口只读');
    setError(message);
  }
  const persist = useCallback((options: WorkspaceSaveOptions = {}) => {
    const snapshot = localSnapshot();
    if (!snapshot) return Promise.resolve();
    if (stale.current) return Promise.reject(new WorkspaceChangedError());
    const saveEpoch = snapshot.epoch!;
    setSaveState('正在保存');
    const saved = queue.current
      .catch(() => {})
      .then(async () => {
        const merged = await saveWorkspace(snapshot, { ...options, expectedEpoch: saveEpoch });
        if (epochRef.current !== saveEpoch) return;
        const current = engineRef.current;
        if (current?.project.id === merged.id) {
          const known = new Set(current.project.operations.map((op) => op.id));
          if (merged.operations.some((op) => !known.has(op.id))) {
            current.merge(merged);
            redraw();
          }
        }
        setSaveState('已存于本机');
        channel.current?.postMessage({ projectId: merged.id, epoch: saveEpoch });
      })
      .catch((err) => {
        if (err instanceof WorkspaceChangedError) {
          markStale(err.message);
        } else {
          setSaveState('保存失败');
          setError(
            `本地保存失败，请立即导出工程：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      });
    queue.current = saved;
    return saved;
  }, []);
  async function waitForSave() {
    let pending: Promise<void>;
    do {
      pending = queue.current;
      await pending;
    } while (pending !== queue.current);
  }
  function ensureReviews(engine: NotebookEngine) {
    for (const note of engine.state.notes)
      for (const block of note.blocks) {
        const key = `review:${block.id}`,
          old = engine.state.settings[key] as ReviewCard | undefined;
        const at = blockContentModifiedAt(engine.project, engine, note.id, block.id);
        if (!old) engine.setSetting(key, createReviewCard(block.id, note.id, at));
        else if (old.modifiedAt < at) engine.setSetting(key, touchReviewCard(old, at));
      }
  }
  function dirtyObjects(engine: NotebookEngine) {
    if (role !== 'tablet' || stale.current) return;
    const known = engine.state.settings;
    const dirty = engine.state.notes.flatMap((n) =>
      n.pages.flatMap((p) =>
        p.objects
          .filter((o) => !o.deleted && !o.revisionId && known[`processed:${o.id}`] !== o.version)
          .map((o) => ({
            id: o.id,
            revision: o.version,
            kind:
              o.kind === 'formula'
                ? ('formula' as const)
                : o.kind === 'stroke'
                  ? ('stroke' as const)
                  : o.kind === 'image'
                    ? ('image' as const)
                    : ('text' as const),
            text: o.text,
            points: o.points,
            noteId: n.id,
          })),
      ),
    );
    if (dirty.length) processor.current?.markDirty(dirty);
  }
  const transact = (
    action: (engine: NotebookEngine) => void,
    options: WorkspaceSaveOptions = {},
  ): boolean => {
    const engine = engineRef.current;
    if (!engine) return false;
    if (stale.current || switching.current) {
      setError('工程正在切换或已由其他窗口恢复；本窗口内容仍可导出。');
      return false;
    }
    const result = atomicAction(engine, (current) => {
      action(current);
      ensureReviews(current);
    });
    engineRef.current = result.engine;
    if (!result.ok) {
      setError(result.error instanceof Error ? result.error.message : String(result.error));
      redraw();
      return false;
    }
    redraw();
    dirtyObjects(result.engine);
    void persist(options).catch(() => {});
    return true;
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await readLocal<StoredWorkspace>('current');
        const project =
          stored?.project ??
          (role === 'tablet' && import.meta.env.DEV ? seedWorkspace(writerId).project : undefined);
        const engine = new NotebookEngine(project, writerId, role),
          epoch = stored?.epoch ?? crypto.randomUUID();
        ensureReviews(engine);
        try {
          const merged = await saveWorkspace(
            {
              project: engine.project,
              epoch,
              draft: null,
              cursor: stored?.cursor ?? 0,
              syncIdentity: stored?.syncIdentity,
            },
            { expectedEpoch: workspaceEpoch(stored) },
          );
          engine.merge(merged);
        } catch (err) {
          if (err instanceof WorkspaceChangedError && attempt < 2) continue;
          throw err;
        }
        if (cancelled) return;
        engineRef.current = engine;
        epochRef.current = epoch;
        cursor.current = stored?.cursor ?? 0;
        setProcessorEpoch(epoch);
        setPendingDrafts(await listDrafts());
        await refreshRecoveries();
        const config = await readLocal<SyncConfig>('sync-config');
        if (config && config.projectId === engine.project.id) {
          configRef.current = config;
          setSyncConfig(config);
        }
        setSaveState('已存于本机');
        setReady(true);
        redraw();
        setPersistent(await requestPersistentStorage());
        return;
      }
    })().catch((err) => {
      setError(`无法打开本地资料库：${err instanceof Error ? err.message : String(err)}`);
      setSaveState('打开失败');
      setReady(true);
    });
    channel.current = new BroadcastChannel('quiet-paper-changes');
    channel.current.onmessage = async () => {
      try {
        const current = await readLocal<StoredWorkspace>('current'),
          engine = engineRef.current;
        if (!current || !engine) return;
        if (
          workspaceEpoch(current) !== epochRef.current ||
          current.project.id !== engine.project.id
        ) {
          markStale();
          return;
        }
        if (!stale.current) {
          const known = new Set(engine.project.operations.map((op) => op.id));
          if (current.project.operations.some((op) => !known.has(op.id))) {
            engine.merge(current.project);
            redraw();
          }
        }
      } catch (err) {
        setError(String(err));
      }
    };
    return () => {
      cancelled = true;
      channel.current?.close();
      invalidateSync();
      processor.current?.dispose();
    };
  }, []);
  useEffect(() => {
    if (!ready || !engineRef.current || stale.current) return;
    const projectId = engineRef.current.project.id,
      epoch = epochRef.current;
    const instance = new IncrementalProcessor({
      idleMs: Number(engineRef.current.state.settings.idleMs ?? 1400),
      stages: engineRef.current.state.settings.stages as never,
      provider,
      onStatus: setStatuses,
      onResults: (results: RecognitionResult[]) => {
        const engine = engineRef.current;
        if (
          !engine ||
          engine.project.id !== projectId ||
          epochRef.current !== epoch ||
          stale.current ||
          switching.current
        )
          return;
        transact((current) => {
          const grouped = new Map<string, RecognitionResult[]>();
          for (const r of results) {
            const list = grouped.get(r.objectId) ?? [];
            list.push(r);
            grouped.set(r.objectId, list);
          }
          for (const [id, rs] of grouped) {
            const note = current.state.notes.find((n) =>
              n.pages.some((p) =>
                p.objects.some((o) => o.id === id && !o.deleted && o.version === rs[0].revision),
              ),
            );
            if (!note) continue;
            const obj = note.pages.flatMap((p) => p.objects).find((o) => o.id === id)!,
              candidate = rs.find((r) => ['ocr', 'formula'].includes(r.stage));
            if (candidate) {
              const already = note.blocks.some((b) =>
                b.segments.some((s) => !s.deleted && s.source.objectIds.includes(id)),
              );
              if (
                candidate.mapping === 'exact-object' &&
                obj.text &&
                !already &&
                role === 'tablet'
              ) {
                const block = current.createBlock(
                  note.id,
                  obj.kind === 'formula' ? '公式' : '随记',
                  [id],
                );
                current.recognize(note.id, block, [id], obj.text, {
                  kind: obj.kind === 'formula' ? 'formula' : 'text',
                  deterministic: true,
                  confidence: 1,
                });
              } else if (candidate.mapping === 'unmapped' && !already)
                current.setSetting(`candidate:${id}`, { ...candidate, noteId: note.id });
            }
            current.setSetting(`processed:${id}`, rs[0].revision);
          }
        });
      },
    });
    processor.current = instance;
    dirtyObjects(engineRef.current);
    const close = () => {
      void instance.closeNote();
    };
    window.addEventListener('pagehide', close);
    return () => {
      instance.dispose();
      window.removeEventListener('pagehide', close);
    };
  }, [ready, provider, processorEpoch]);
  useEffect(() => {
    if (!ready || !syncConfig || !engineRef.current || stale.current || switching.current) return;
    if (syncConfig.mode === 'e2ee' && !syncConfig.passphrase) {
      setSyncState('待解锁');
      return;
    }
    const lease = syncGuard.current.begin(engineRef.current.project.id, epochRef.current);
    const check = () =>
      syncGuard.current.assert(lease, engineRef.current?.project.id, epochRef.current);
    const handle = startAutoSync({
      config: syncConfig,
      getOperations: () => {
        check();
        return engineRef.current!.project.operations as unknown as SyncOperation[];
      },
      getCursor: () => {
        check();
        return cursor.current;
      },
      applyRemote: async (ops) => {
        check();
        const result = atomicAction(engineRef.current!, (engine) =>
          engine.merge({ ...engine.project, operations: ops as unknown as Project['operations'] }),
        );
        engineRef.current = result.engine;
        if (!result.ok) throw result.error;
        redraw();
        await persist();
        check();
      },
      setCursor: async (value) => {
        check();
        cursor.current = value;
        await persist();
        check();
      },
      getAcknowledgedIds: async (identity) => {
        check();
        const ids = (await readLocal<string[]>('sync-ack:' + identity)) ?? [];
        check();
        return ids;
      },
      setAcknowledgedIds: async (identity, ids) => {
        check();
        await writeLocal('sync-ack:' + identity, ids);
        check();
      },
      onStatus: (status, message) => {
        if (!syncGuard.current.current(lease, engineRef.current?.project.id, epochRef.current))
          return;
        setSyncState(
          {
            syncing: '正在同步',
            synced: '同步完成',
            offline: '离线 · 等待重连',
            error: '同步待处理',
          }[status],
        );
        setSyncError(message ?? '');
      },
    });
    syncHandle.current = handle;
    return () => {
      handle.stop();
      if (syncGuard.current.current(lease, engineRef.current?.project.id, epochRef.current))
        syncGuard.current.invalidate();
      if (syncHandle.current === handle) syncHandle.current = null;
    };
  }, [ready, syncConfig]);
  function checkpoint(value: DraftStroke | null) {
    if (!value) {
      const cancelled = draft.current;
      draft.current = null;
      processor.current?.setWriting(false);
      if (cancelled)
        void persist({ consumeDraft: { key: draftKey, expected: cancelled } }).catch(() => {});
      return;
    }
    processor.current?.setWriting(true);
    const previous = draft.current,
      next: DraftStroke = {
        ...value,
        id: value.id ?? previous?.id ?? crypto.randomUUID(),
        projectId: engineRef.current?.project.id,
        deviceId: installationId,
        updatedAt: Date.now(),
      };
    draft.current = next;
    void writeLocal(draftKey, structuredClone(next)).catch((err) =>
      setError(`笔迹检查点失败：${err instanceof Error ? err.message : String(err)}`),
    );
  }
  function stroke(
    noteId: string,
    pageId: string,
    points: Point[],
    options: { color: string; width: number; layerId: string },
  ) {
    const completed = draft.current;
    draft.current = null;
    processor.current?.setWriting(false);
    transact(
      (engine) => {
        engine.addStroke(noteId, pageId, points, { ...options, draftId: completed?.id });
      },
      completed ? { consumeDraft: { key: draftKey, expected: completed } } : {},
    );
  }
  async function refreshPendingDrafts() {
    setPendingDrafts(
      (await listDrafts()).filter((entry) => entry.key !== draftKey || !draft.current),
    );
  }
  async function recoverDraft(key: string, confirmedInactive = false) {
    if (role !== 'tablet') throw new Error('恢复原始笔迹仅限 Android 平板');
    if (!confirmedInactive) throw new Error('请先确认原窗口已停止书写，再恢复这份笔迹');
    const point = await readLocal<DraftStroke>(key),
      engine = engineRef.current;
    if (!point?.points.length || !engine) throw new Error('待恢复笔迹已被消费或不存在');
    if (point.projectId && point.projectId !== engine.project.id)
      throw new Error('待恢复笔迹属于其他工程，已保留原检查点');
    if (
      !engine.state.notes.some(
        (n) => n.id === point.noteId && n.pages.some((p) => p.id === point.pageId),
      )
    )
      throw new Error('找不到原纸张，检查点已保留');
    if (
      !transact(
        (current) => {
          current.addStroke(point.noteId, point.pageId, point.points, {
            ...point,
            draftId: point.id ?? `legacy:${key}`,
          });
        },
        { consumeDraft: { key, expected: point } },
      )
    )
      throw new Error('恢复未提交，检查点已保留');
    await waitForSave();
    await refreshPendingDrafts();
  }
  async function connect(config: SyncConfig) {
    invalidateSync();
    const engine = engineRef.current;
    if (!engine || stale.current || switching.current) throw new Error('请先重新打开当前工程');
    await waitForSave();
    if (config.projectId !== engine.project.id) {
      if (engine.state.notes.length) throw new Error('工程标识不一致，请先导入对应工程');
      switching.current = true;
      try {
        const next = await replaceWorkspace(
          {
            project: { ...engine.project, id: config.projectId },
            cursor: 0,
            syncIdentity: connectionIdentity(config),
          },
          epochRef.current,
          localSnapshot(),
        );
        engineRef.current = new NotebookEngine(next.project, writerId, role);
        epochRef.current = next.epoch!;
        cursor.current = 0;
        channel.current?.postMessage({ projectId: next.project.id, epoch: next.epoch });
        redraw();
      } finally {
        switching.current = false;
        setProcessorEpoch(epochRef.current);
      }
    }
    const identity = connectionIdentity(config),
      stored = await readLocal<StoredWorkspace>('current');
    if (workspaceEpoch(stored) !== epochRef.current) {
      markStale();
      throw new WorkspaceChangedError();
    }
    if (stored?.syncIdentity !== identity) cursor.current = 0;
    await writeLocal('sync-config', { ...config, passphrase: undefined });
    configRef.current = config;
    setSyncConfig(config);
  }
  async function disconnect() {
    invalidateSync();
    configRef.current = null;
    setSyncConfig(null);
    setSyncState('未连接');
    await writeLocal('sync-config', null);
  }
  async function importProject(json: string) {
    const project = NotebookEngine.importProject(json);
    if (stale.current) throw new WorkspaceChangedError();
    invalidateSync();
    processor.current?.dispose();
    switching.current = true;
    try {
      await waitForSave();
      const local = localSnapshot();
      const next = await replaceWorkspace(
        { project, draft: null, cursor: 0, syncIdentity: '' },
        epochRef.current,
        local,
      );
      engineRef.current = new NotebookEngine(next.project, writerId, role);
      epochRef.current = next.epoch!;
      cursor.current = 0;
      draft.current = null;
      configRef.current = null;
      setSyncConfig(null);
      setSyncState('未连接');
      stale.current = false;
      setSaveState('已存于本机');
      setProvider(undefined);
      setStatuses(undefined);
      setError('');
      setPendingDrafts(await listDrafts());
      await refreshRecoveries();
      channel.current?.postMessage({ projectId: project.id, epoch: next.epoch });
      redraw();
    } finally {
      switching.current = false;
      setProcessorEpoch(epochRef.current);
    }
  }
  async function durableSnapshot() {
    await persist();
    await waitForSave();
    return engineRef.current ? structuredClone(engineRef.current.project) : undefined;
  }
  return {
    engine: engineRef.current,
    getEngine: () => engineRef.current,
    installationId,
    waitForSave,
    awaitIdle: waitForSave,
    durableSnapshot,
    ready,
    version,
    role,
    saveState,
    error,
    setError,
    persistent,
    transact,
    checkpoint,
    stroke,
    pendingDrafts,
    refreshPendingDrafts,
    recoverDraft,
    recoverySnapshots,
    listRecoverySnapshots: refreshRecoveries,
    importProject,
    flush: () => processor.current?.flush('manual'),
    closeNote: () => processor.current?.closeNote(),
    statuses,
    configureProcessor: (options: Parameters<IncrementalProcessor['configure']>[0]) =>
      processor.current?.configure(options),
    provider,
    setProvider,
    syncState,
    syncError,
    syncConfig,
    connect,
    disconnect,
    syncNow: () => syncHandle.current?.syncNow(),
  };
}
