import { NotebookEngine, type Project, type Point } from './domain';

/** Immutable operation snapshots allow rollback without cloning every committed pen gesture. */
export function atomicAction(
  engine: NotebookEngine,
  action: (engine: NotebookEngine) => void,
): { ok: true; engine: NotebookEngine } | { ok: false; engine: NotebookEngine; error: unknown } {
  const before = engine.project;
  try {
    action(engine);
    return { ok: true, engine };
  } catch (error) {
    return { ok: false, engine: new NotebookEngine(before, engine.deviceId, engine.role), error };
  }
}
export type SyncLease = { generation: number; projectId: string; epoch: string };
export class SyncSessionGuard {
  private generation = 0;
  invalidate() {
    this.generation++;
  }
  begin(projectId: string, epoch: string): SyncLease {
    this.invalidate();
    return { generation: this.generation, projectId, epoch };
  }
  current(lease: SyncLease, projectId?: string, epoch?: string) {
    return (
      this.generation === lease.generation && lease.projectId === projectId && lease.epoch === epoch
    );
  }
  assert(lease: SyncLease, projectId?: string, epoch?: string) {
    if (!this.current(lease, projectId, epoch))
      throw new Error('同步会话已切换，旧响应未应用；未确认操作仍保留。');
  }
}
function translated(before: Point[] | undefined, after: Point[] | undefined) {
  if (!before?.length || !after || before.length !== after.length) return false;
  const dx = after[0].x - before[0].x,
    dy = after[0].y - before[0].y;
  return after.every(
    (p, i) =>
      Math.abs(p.x - before[i].x - dx) < 1e-7 &&
      Math.abs(p.y - before[i].y - dy) < 1e-7 &&
      p.pressure === before[i].pressure &&
      p.tiltX === before[i].tiltX &&
      p.tiltY === before[i].tiltY &&
      p.time === before[i].time,
  );
}
/** Review follows this block's content, never unrelated ink elsewhere in the notebook. */
export function blockContentModifiedAt(
  project: Project,
  engine: NotebookEngine,
  noteId: string,
  blockId: string,
): number {
  const note = engine.getNote(noteId),
    block = note.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error('Knowledge block not found');
  const ids = new Set([...block.objectIds, ...block.segments.flatMap((s) => s.source.objectIds)]),
    segmentIds = new Set(block.segments.map((s) => s.id));
  let modified = Math.max(note.createdAt, ...block.versions.map((v) => v.at));
  for (const op of project.operations) {
    const p = op.payload;
    if (p.noteId !== noteId) continue;
    const contentObjectUpdate =
      op.type === 'object.update' &&
      ids.has(p.objectId) &&
      (p.changes.text !== undefined ||
        (p.changes.points !== undefined && !translated(p.baseValues?.points, p.changes.points)));
    const objectChange =
      (op.type === 'object.create' && ids.has(p.object.id)) ||
      (op.type === 'object.delete' && ids.has(p.objectId)) ||
      contentObjectUpdate;
    const segmentChange =
      ['segment.create', 'segment.edit', 'segment.delete'].includes(op.type) &&
      segmentIds.has(p.segmentId);
    const conflict =
      op.type === 'conflict.resolve'
        ? engine.state.conflicts.find((c) => c.id === p.conflictId)
        : undefined;
    if (
      objectChange ||
      segmentChange ||
      (op.type === 'block.create' && p.blockId === blockId) ||
      (conflict && (segmentIds.has(conflict.segmentId ?? '') || ids.has(conflict.objectId ?? '')))
    )
      modified = Math.max(modified, op.at);
  }
  return modified;
}
