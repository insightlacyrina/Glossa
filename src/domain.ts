/** Durable, deterministic A/B model. Paper is never flattened into an image. */
import {
  captureHandwritingGlyph,
  composeHandwriting,
  validateHandwritingGlyph,
  type HandwritingGlyph,
} from './handwriting';
export type Role = 'tablet' | 'phone' | 'mac';
export type Point = {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  time: number;
};
export type Bounds = { x: number; y: number; width: number; height: number };
export type PaperSpec = {
  size?: 'A4' | 'B5' | 'custom';
  orientation?: 'portrait' | 'landscape';
  template?: 'blank' | 'ruled' | 'grid' | 'dot';
  width?: number;
  height?: number;
};
export type PaperObject = {
  id: string;
  pageId: string;
  kind: 'stroke' | 'text' | 'formula' | 'image' | 'shape' | 'reference';
  layerId: string;
  bounds: Bounds;
  points?: Point[];
  text?: string;
  color?: string;
  width?: number;
  data?: string;
  deleted?: boolean;
  revisionId?: string;
  replacesObjectIds?: string[];
  version: string;
};
export type Page = {
  id: string;
  size: 'A4' | 'B5' | 'custom';
  orientation: 'portrait' | 'landscape';
  template: 'blank' | 'ruled' | 'grid' | 'dot';
  width: number;
  height: number;
  objects: PaperObject[];
};
export type Character = {
  id: string;
  value: string;
  deleted: boolean;
  version: string;
  afterId: string | null;
  order: string;
  sourceObjectIds?: string[];
  glyphIds?: string[];
};
export type SourceMapping = {
  status: 'exact' | 'unmapped';
  precision: 'character' | 'object' | 'none';
  objectIds: string[];
  reason?: string;
  confidence: number;
  evidence: 'user-confirmed' | 'deterministic' | 'unverified';
  objectVersions: Record<string, string>;
};
export type Segment = {
  id: string;
  blockId: string;
  kind: 'text' | 'formula' | 'reference';
  chars: Character[];
  text: string;
  source: SourceMapping;
  deleted?: boolean;
  preview?: string;
};
export type BlockVersion = { eventId: string; at: number; segmentId: string; text: string };
export type KnowledgeBlock = {
  id: string;
  title: string;
  pageIds: string[];
  objectIds: string[];
  segments: Segment[];
  relatedBlockIds: string[];
  versions: BlockVersion[];
};
export type Note = {
  id: string;
  title: string;
  pages: Page[];
  blocks: KnowledgeBlock[];
  folderId: string | null;
  tags: string[];
  createdAt: number;
  modifiedAt: number;
};
export type Conflict = {
  id: string;
  kind: 'character' | 'dependency' | 'object' | 'structure';
  noteId: string;
  segmentId?: string;
  charId?: string;
  objectId?: string;
  current: string;
  incoming: string;
  currentEventId: string;
  incomingEventId: string;
  resolved?: boolean;
  deleteObjectId?: string;
  deleteSegmentId?: string;
  undoRevisionId?: string;
};
export type Correction = {
  id: string;
  eventId: string;
  noteId: string;
  segmentId: string;
  objectId: string;
  before: string;
  after: string;
  mode: 'printed' | 'handwriting';
  handwritingTarget?: { pageId: string; bounds: Bounds; replacesObjectIds: string[] };
  sampleIds?: string[];
  handwritingVersion?: string;
  status: 'pending';
  reason: string;
  needsPlacement?: boolean;
  objectIds?: string[];
};
export type Operation = {
  id: string;
  deviceId: string;
  role: Role;
  seq: number;
  clock: number;
  at: number;
  type: string;
  payload: Record<string, any>;
  seen?: Record<string, number>;
};
export type Project = {
  schemaVersion: 1;
  id: string;
  operations: Operation[];
  metadata: Record<string, unknown>;
};
export type NotebookState = {
  notes: Note[];
  conflicts: Conflict[];
  corrections: Correction[];
  handwritingGlyphs: HandwritingGlyph[];
  mergedRevisionIds: string[];
  undoneRevisionIds: string[];
  events: Operation[];
  folders: { id: string; name: string; subject?: string }[];
  settings: Record<string, unknown>;
  blockAliases: Record<string, string>;
  blockArchive: {
    noteId: string;
    eventId: string;
    reason: 'split' | 'merge';
    block: KnowledgeBlock;
  }[];
};
export type RecognitionOptions = {
  kind?: 'text' | 'formula' | 'reference';
  confidence?: number;
  confirmed?: boolean;
  deterministic?: boolean;
  reason?: string;
  preview?: string;
  charMap?: { index: number; objectIds: string[]; glyphIds?: string[] }[];
};
type CharPatch = { charId: string; value?: string; deleted?: boolean; baseVersion: string };
const clone = <T>(x: T): T => structuredClone(x);
const uid = () => globalThis.crypto.randomUUID();
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function canonical(value: any): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') +
    '}'
  );
}
function concurrent(a: Operation, b: Operation) {
  return (
    a.id !== b.id && (a.seen?.[b.deviceId] ?? 0) < b.seq && (b.seen?.[a.deviceId] ?? 0) < a.seq
  );
}
function observed(ops: Operation[]): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const op of ops) seen[op.deviceId] = Math.max(seen[op.deviceId] ?? 0, op.seq);
  return seen;
}

const tabletOnly = new Set([
  'note.create',
  'page.create',
  'object.create',
  'object.update',
  'object.delete',
  'block.create',
  'block.link',
  'block.split',
  'block.merge',
  'segment.create',
  'segment.map',
  'segment.transcribe',
  'segment.delete',
  'revision.merge',
  'revision.undo',
  'handwriting.learn',
  'revision.handwriting',
  'revision.stroke.split',
]);
const allowed = new Set([
  ...tabletOnly,
  'segment.edit',
  'conflict.resolve',
  'note.manage',
  'folder.create',
  'setting.set',
]);
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
function checkOperation(op: Operation) {
  if (
    !op ||
    !allowed.has(op.type) ||
    typeof op.id !== 'string' ||
    !op.id ||
    typeof op.deviceId !== 'string' ||
    !op.deviceId ||
    forbiddenKeys.has(op.deviceId) ||
    !Number.isSafeInteger(op.seq) ||
    op.seq < 1 ||
    !['tablet', 'phone', 'mac'].includes(op.role) ||
    !Number.isSafeInteger(op.clock) ||
    op.clock < 1 ||
    !Number.isFinite(op.at) ||
    !op.payload ||
    typeof op.payload !== 'object' ||
    Array.isArray(op.payload)
  )
    throw new Error('Invalid operation');
  if (
    op.seen !== undefined &&
    (!op.seen ||
      typeof op.seen !== 'object' ||
      Array.isArray(op.seen) ||
      Object.entries(op.seen).some(
        ([key, value]) => forbiddenKeys.has(key) || !Number.isSafeInteger(value) || value < 0,
      ))
  )
    throw new Error('Invalid causal clock');
  if (tabletOnly.has(op.type) && op.role !== 'tablet')
    throw new Error('This operation requires the Android tablet');
  const p = op.payload;
  if (op.type === 'handwriting.learn') validateHandwritingGlyph(p.glyph);
  if (
    op.type === 'revision.handwriting' &&
    (typeof p.revisionId !== 'string' || typeof p.fingerprint !== 'string')
  )
    throw new Error('Invalid handwriting retry');
  if (
    op.type === 'revision.stroke.split' &&
    (typeof p.objectId !== 'string' ||
      typeof p.revisionId !== 'string' ||
      typeof p.baseVersion !== 'string' ||
      !Array.isArray(p.fragments) ||
      p.fragments.length > 128 ||
      p.fragments.some(
        (part: any, i: number) =>
          !part ||
          typeof part.id !== 'string' ||
          !part.id ||
          (i === 0 && part.id !== p.objectId) ||
          !Array.isArray(part.points) ||
          !part.points.length ||
          part.points.some(
            (point: Point) =>
              !point ||
              !['x', 'y', 'pressure', 'tiltX', 'tiltY', 'time'].every(
                (k) => typeof (point as any)[k] === 'number' && Number.isFinite((point as any)[k]),
              ),
          ),
      ) ||
      new Set(p.fragments.map((part: any) => part.id)).size !== p.fragments.length ||
      p.fragments.reduce((n: number, part: any) => n + part.points.length, 0) > 150000)
  )
    throw new Error('Invalid revision stroke fragments');
  if (op.type === 'object.create') {
    const obj = p.object;
    if (
      !obj ||
      typeof obj.id !== 'string' ||
      !obj.id ||
      !['stroke', 'text', 'formula', 'image', 'shape', 'reference'].includes(obj.kind) ||
      typeof obj.layerId !== 'string' ||
      !obj.bounds ||
      !['x', 'y', 'width', 'height'].every(
        (k) => typeof obj.bounds[k] === 'number' && Number.isFinite(obj.bounds[k]),
      ) ||
      obj.bounds.width < 0 ||
      obj.bounds.height < 0
    )
      throw new Error('Invalid paper object');
    if (
      obj.kind === 'stroke' &&
      (!Array.isArray(obj.points) ||
        !obj.points.length ||
        obj.points.some(
          (point: Point) =>
            !point ||
            !['x', 'y', 'pressure', 'tiltX', 'tiltY', 'time'].every(
              (k) => typeof (point as any)[k] === 'number' && Number.isFinite((point as any)[k]),
            ),
        ))
    )
      throw new Error('Invalid stroke data');
    if (obj.text !== undefined && typeof obj.text !== 'string')
      throw new Error('Invalid object text');
    if (obj.data !== undefined && typeof obj.data !== 'string')
      throw new Error('Invalid object data');
  }
  if (
    op.type === 'segment.create' &&
    (typeof p.text !== 'string' ||
      !Array.isArray(p.objectIds) ||
      p.objectIds.some((x: unknown) => typeof x !== 'string') ||
      !p.options ||
      !['text', 'formula', 'reference', undefined].includes(p.options.kind))
  )
    throw new Error('Invalid recognition result');
  if (op.type === 'segment.edit' || op.type === 'segment.transcribe') {
    if (
      !Array.isArray(p.patches) ||
      !Array.isArray(p.inserts) ||
      p.patches.some(
        (patch: CharPatch) =>
          !patch ||
          typeof patch.charId !== 'string' ||
          typeof patch.baseVersion !== 'string' ||
          (patch.value !== undefined &&
            (typeof patch.value !== 'string' || Array.from(patch.value).length !== 1)) ||
          (patch.deleted !== undefined && typeof patch.deleted !== 'boolean'),
      )
    )
      throw new Error('Invalid character patch');
    if (
      p.inserts.some(
        (c: Character) =>
          !c ||
          typeof c.id !== 'string' ||
          typeof c.value !== 'string' ||
          Array.from(c.value).length !== 1 ||
          typeof c.order !== 'string' ||
          c.version !== op.id ||
          (c.afterId !== null && typeof c.afterId !== 'string'),
      ) ||
      new Set(p.inserts.map((c: Character) => c.id)).size !== p.inserts.length
    )
      throw new Error('Invalid inserted character');
  }
}
function makePaper(id: string, spec: PaperSpec = {}): Page {
  const size = spec.size ?? 'A4',
    orientation = spec.orientation ?? 'portrait';
  if (
    !['A4', 'B5', 'custom'].includes(size) ||
    !['portrait', 'landscape'].includes(orientation) ||
    !['blank', 'ruled', 'grid', 'dot'].includes(spec.template ?? 'dot')
  )
    throw new Error('Invalid paper specification');
  const base =
    size === 'B5'
      ? [704, 1000]
      : size === 'custom'
        ? [spec.width ?? 800, spec.height ?? 1100]
        : [794, 1123];
  if (!base.every((n) => Number.isFinite(n) && n >= 100 && n <= 20000))
    throw new Error('Invalid paper dimensions');
  const [width, height] =
    orientation === 'landscape'
      ? [Math.max(...base), Math.min(...base)]
      : [Math.min(...base), Math.max(...base)];
  return { id, size, orientation, template: spec.template ?? 'dot', width, height, objects: [] };
}
function orderedChars(chars: Character[]): Character[] {
  const children = new Map<string | null, Character[]>();
  for (const ch of chars) {
    const k = ch.afterId;
    const list = children.get(k) ?? [];
    list.push(ch);
    children.set(k, list);
  }
  for (const list of children.values()) list.sort((a, b) => lexical(b.order, a.order));
  const out: Character[] = [],
    seen = new Set<string>();
  const visit = (id: string | null) => {
    for (const c of children.get(id) ?? [])
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
        visit(c.id);
      }
  };
  visit(null);
  return out;
}
function refresh(seg: Segment) {
  seg.chars = orderedChars(seg.chars);
  seg.text = seg.chars
    .filter((c) => !c.deleted)
    .map((c) => c.value)
    .join('');
}
function lookup(state: NotebookState, noteId: string, segmentId?: string) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) throw new Error('Note not found');
  const block = segmentId
    ? note.blocks.find((b) => b.segments.some((s) => s.id === segmentId))
    : undefined;
  const segment = block?.segments.find((s) => s.id === segmentId);
  return { note, block, segment };
}
function resolveAlias(state: NotebookState, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (state.blockAliases[current]) {
    if (seen.has(current)) throw new Error('Block alias cycle');
    seen.add(current);
    current = state.blockAliases[current];
  }
  return current;
}
function structureFingerprint(note: Note): string {
  return canonical(
    note.blocks.map((b) => ({
      id: b.id,
      title: b.title,
      segments: b.segments.map((s) => s.id),
      relations: b.relatedBlockIds,
    })),
  );
}
function objects(note: Note) {
  return note.pages.flatMap((p) => p.objects);
}
function unionBounds(obs: PaperObject[]): Bounds {
  if (!obs.length) return { x: 60, y: 80, width: 600, height: 48 };
  const x = Math.min(...obs.map((o) => o.bounds.x)),
    y = Math.min(...obs.map((o) => o.bounds.y));
  return {
    x,
    y,
    width: Math.max(...obs.map((o) => o.bounds.x + o.bounds.width)) - x,
    height: Math.max(40, Math.max(...obs.map((o) => o.bounds.y + o.bounds.height)) - y),
  };
}
function projectState(project: Project): NotebookState {
  const state: NotebookState = {
    notes: [],
    conflicts: [],
    corrections: [],
    handwritingGlyphs: [],
    mergedRevisionIds: [],
    undoneRevisionIds: [],
    events: [],
    folders: [],
    settings: {},
    blockAliases: {},
    blockArchive: [],
  };
  const events = [...project.operations].sort((a, b) => a.clock - b.clock || lexical(a.id, b.id));
  const revisionChanges = new Map<
    string,
    {
      segmentId: string;
      noteId: string;
      patches: {
        charId: string;
        value: string;
        deleted: boolean;
        resultingVersion: string;
        sourceObjectIds?: string[];
        glyphIds?: string[];
      }[];
      inserted: string[];
    }
  >();
  const addConflict = (c: Conflict) => {
    if (!state.conflicts.some((x) => x.id === c.id)) state.conflicts.push(c);
  };
  const applyStructure = (operation: Operation, force = false): boolean => {
    const p = operation.payload,
      note = state.notes.find((n) => n.id === p.noteId);
    if (!note) throw new Error('Structure note missing');
    const describe = () =>
      note.blocks
        .map(
          (b) =>
            `${b.title} [${b.id}]\n${b.segments
              .filter((s) => !s.deleted)
              .map((s) => s.text)
              .join('\n')}`,
        )
        .join('\n\n');
    const conflict = (reason: string) => {
      addConflict({
        id: operation.id,
        kind: 'structure',
        noteId: note.id,
        current: describe(),
        incoming: reason,
        currentEventId:
          state.events.filter((e) => e.type === 'block.split' || e.type === 'block.merge').at(-2)
            ?.id ?? operation.id,
        incomingEventId: operation.id,
      });
      return false;
    };
    const archive = (blocks: KnowledgeBlock[], reason: 'split' | 'merge') => {
      for (const block of blocks)
        state.blockArchive.push({
          noteId: note.id,
          eventId: operation.id,
          reason,
          block: clone(block),
        });
    };
    const membership = (block: KnowledgeBlock, extra: string[] = []) => {
      block.objectIds = [
        ...new Set([...extra, ...block.segments.flatMap((s) => s.source.objectIds)]),
      ];
      block.pageIds = [
        ...new Set(
          objects(note)
            .filter((o) => block.objectIds.includes(o.id))
            .map((o) => o.pageId),
        ),
      ];
    };
    if (operation.type === 'block.split') {
      const source = note.blocks.find((b) => b.id === resolveAlias(state, p.blockId));
      if (!source) throw new Error('Split source block missing');
      const selected = new Set<string>(p.segmentIds);
      if (
        !selected.size ||
        !Array.isArray(p.baseSegmentIds) ||
        selected.size >= p.baseSegmentIds.length ||
        [...selected].some((id) => !p.baseSegmentIds.includes(id))
      )
        throw new Error('Split must select a true nonempty subset');
      if (!force && [...selected].some((id) => !source.segments.some((s) => s.id === id)))
        return conflict(
          `拆分为「${p.title}」\n${p.segmentIds.map((id: string) => note.blocks.flatMap((b) => b.segments).find((s) => s.id === id)?.text ?? id).join('\n')}\n部分段落已属于其他知识块，请确认归属`,
        );
      const donors = note.blocks.filter((b) => b.segments.some((s) => selected.has(s.id))),
        moved = note.blocks.flatMap((b) => b.segments).filter((s) => selected.has(s.id));
      if (moved.length !== selected.size) throw new Error('Split segment missing');
      archive([...new Set([source, ...donors])], 'split');
      const selectedInOrder = (p.segmentIds as string[]).map(
        (id) => moved.find((s) => s.id === id)!,
      );
      const versions = donors.flatMap((b) => b.versions).filter((v) => selected.has(v.segmentId)),
        created: KnowledgeBlock = {
          id: p.newBlockId,
          title: p.title,
          pageIds: [],
          objectIds: [],
          segments: selectedInOrder,
          relatedBlockIds: [],
          versions,
        };
      for (const donor of donors) {
        const extra = donor.objectIds.filter(
          (id) => !donor.segments.some((s) => s.source.objectIds.includes(id)),
        );
        donor.segments = donor.segments.filter((s) => !selected.has(s.id));
        donor.versions = donor.versions.filter((v) => !selected.has(v.segmentId));
        membership(donor, extra);
      }
      for (const segment of created.segments) segment.blockId = created.id;
      membership(created);
      const existing = note.blocks.find((b) => b.id === created.id);
      if (existing) throw new Error('Split block identity already exists');
      note.blocks.splice(note.blocks.indexOf(source) + 1, 0, created);
    } else {
      const requested = p.blockIds as string[];
      if (!Array.isArray(requested) || new Set(requested).size < 2)
        throw new Error('Merge requires multiple blocks');
      const ids = [...new Set(requested.map((id) => resolveAlias(state, id)))],
        blocks = ids.map((id) => note.blocks.find((b) => b.id === id));
      if (blocks.some((b) => !b)) throw new Error('Merge block missing');
      const valid = blocks as KnowledgeBlock[],
        survivor = valid[0];
      if (valid.length === 1) {
        if (survivor.title === p.title) return true;
        if (!force)
          return conflict(
            `合并后标题：${p.title}\n${survivor.segments.map((s) => s.text).join('\n')}`,
          );
        archive(valid, 'merge');
        survivor.title = p.title;
        return true;
      }
      archive(valid, 'merge');
      const allObjects = valid.flatMap((b) => b.objectIds),
        segments = valid.flatMap((b) => b.segments),
        versions = valid.flatMap((b) => b.versions),
        relations = valid.flatMap((b) => b.relatedBlockIds);
      survivor.title = p.title;
      survivor.segments = segments;
      for (const segment of segments) segment.blockId = survivor.id;
      survivor.versions = [
        ...new Map(versions.map((v) => [v.eventId + ':' + v.segmentId, v])).values(),
      ].sort((a, b) => a.at - b.at || lexical(a.eventId, b.eventId));
      survivor.relatedBlockIds = [...new Set(relations)];
      membership(survivor, allObjects);
      for (const block of valid.slice(1)) state.blockAliases[block.id] = survivor.id;
      note.blocks = note.blocks.filter((b) => b.id === survivor.id || !ids.includes(b.id));
      for (const n of state.notes)
        for (const block of n.blocks)
          block.relatedBlockIds = [
            ...new Set(block.relatedBlockIds.map((id) => resolveAlias(state, id))),
          ].filter((id) => id !== block.id);
    }
    note.modifiedAt = Math.max(note.modifiedAt, operation.at);
    return true;
  };
  const applyStrokeSplit = (operation: Operation, force = false) => {
    const payload = operation.payload,
      note = state.notes.find((n) => n.id === payload.noteId)!;
    const source = objects(note).find((o) => o.id === payload.objectId);
    const correction = state.corrections.find(
      (c) => c.id === payload.revisionId && c.noteId === note.id,
    );
    if (
      !source ||
      source.deleted ||
      source.kind !== 'stroke' ||
      source.revisionId !== payload.revisionId ||
      !correction
    ) {
      addConflict({
        id: operation.id,
        kind: 'object',
        noteId: note.id,
        objectId: payload.objectId,
        current: '修订已被更新、删除或合并，请在当前笔迹重新擦除',
        incoming: '保留局部擦除候选',
        currentEventId: source?.version ?? operation.id,
        incomingEventId: operation.id,
      });
      return false;
    }
    if (!force && source.version !== payload.baseVersion) {
      addConflict({
        id: operation.id,
        kind: 'object',
        noteId: note.id,
        objectId: source.id,
        current: '笔迹在擦除期间发生其他修改',
        incoming: '局部擦除后的笔迹',
        currentEventId: source.version,
        incomingEventId: operation.id,
      });
      return false;
    }
    const template = clone(source),
      page = note.pages.find((p) => p.id === source.pageId)!;
    const fragments = payload.fragments as { id: string; points: Point[] }[];
    source.deleted = true;
    for (const part of fragments) {
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const p of part.points) {
        left = Math.min(left, p.x);
        top = Math.min(top, p.y);
        right = Math.max(right, p.x);
        bottom = Math.max(bottom, p.y);
      }
      const fragment: PaperObject = {
        ...clone(template),
        id: part.id,
        points: clone(part.points),
        bounds: {
          x: left,
          y: top,
          width: Math.max(1, right - left),
          height: Math.max(1, bottom - top),
        },
        deleted: false,
        version: operation.id,
      };
      if (part.id === source.id) Object.assign(source, fragment);
      else {
        if (objects(note).some((o) => o.id === part.id))
          throw new Error('Duplicate stroke fragment identity');
        page.objects.push(fragment);
      }
    }
    const active = objects(note).filter((o) => o.revisionId === correction.id && !o.deleted);
    correction.objectIds = active.map((o) => o.id);
    correction.objectId = active[0]?.id ?? correction.objectId;
    correction.reason = '修订笔迹已局部擦除；剩余笔迹保留独立修订身份';
    return true;
  };
  const renderHandwriting = (note: Note, correction: Correction, text: string, version: string) => {
    const target = correction.handwritingTarget;
    if (!target || correction.needsPlacement) return;
    const page = note.pages.find((p) => p.id === target.pageId);
    if (!page) return;
    const seg = lookup(state, note.id, correction.segmentId).segment;
    if (!seg || seg.kind !== 'text') return;
    const result = composeHandwriting(text, target.bounds, state.handwritingGlyphs);
    const baseId = correction.objectId;
    for (const old of objects(note).filter((o) => o.revisionId === correction.id))
      old.deleted = true;
    const put = (object: PaperObject) => {
      const existing = page.objects.find((o) => o.id === object.id);
      if (existing) {
        for (const key of Object.keys(existing)) delete (existing as any)[key];
        Object.assign(existing, object);
      } else page.objects.push(object);
    };
    const generated: PaperObject[] = result.strokes.length
      ? result.strokes.map((stroke, index) => {
          let x = Infinity,
            y = Infinity,
            right = -Infinity,
            bottom = -Infinity;
          for (const p of stroke.points) {
            x = Math.min(x, p.x);
            y = Math.min(y, p.y);
            right = Math.max(right, p.x);
            bottom = Math.max(bottom, p.y);
          }
          return {
            id: index === 0 ? baseId : `${baseId}:stroke${index}`,
            pageId: page.id,
            kind: 'stroke',
            layerId: `revision:${correction.id}`,
            points: stroke.points,
            bounds: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
            width: stroke.width,
            color: stroke.color,
            revisionId: correction.id,
            replacesObjectIds: [...target.replacesObjectIds],
            version,
          };
        })
      : [
          {
            id: baseId,
            pageId: page.id,
            kind: 'text',
            text,
            bounds: clone(target.bounds),
            layerId: `revision:${correction.id}`,
            revisionId: correction.id,
            replacesObjectIds: [...target.replacesObjectIds],
            version,
          },
        ];
    for (const object of generated) put(object);
    correction.objectIds = generated.map((o) => o.id);
    correction.mode = result.strokes.length ? 'handwriting' : 'printed';
    correction.sampleIds = result.sampleIds;
    correction.handwritingVersion = version;
    correction.after = text;
    correction.reason =
      result.reason ?? '由已确认的真实字形笔迹生成；保留压力与倾斜，可独立编辑或撤销';
  };
  const finishUndo = (note: Note, seg: Segment, revisionId: string) => {
    const correction = state.corrections.find((c) => c.id === revisionId),
      layers = objects(note).filter((o) => o.revisionId === revisionId),
      otherActive = state.corrections.filter(
        (c) =>
          c.id !== revisionId &&
          c.segmentId === seg.id &&
          objects(note).some((o) => o.revisionId === c.id && !o.deleted),
      );
    if (correction && seg.text !== correction.before && !otherActive.length) {
      const initial = events.find((e) => e.id === revisionId),
        residual = events
          .filter(
            (e) =>
              e.type === 'segment.edit' &&
              e.payload.segmentId === seg.id &&
              e.id !== revisionId &&
              e.clock >= (initial?.clock ?? 0) &&
              revisionChanges.has(e.id),
          )
          .at(-1);
      if (residual) {
        for (const layer of layers) {
          layer.deleted = false;
          layer.revisionId = residual.id;
          layer.layerId = `revision:${residual.id}`;
          layer.text = seg.text;
        }
        const change = revisionChanges.get(residual.id)!,
          beforeChars = clone(seg.chars);
        for (const patch of change.patches) {
          const c = beforeChars.find((c) => c.id === patch.charId);
          if (c) {
            c.value = patch.value;
            c.deleted = patch.deleted;
          }
        }
        for (const id of change.inserted) {
          const c = beforeChars.find((c) => c.id === id);
          if (c) c.deleted = true;
        }
        const before = orderedChars(beforeChars)
          .filter((c) => !c.deleted)
          .map((c) => c.value)
          .join('');
        state.corrections = state.corrections.filter((c) => c.id !== revisionId);
        state.corrections.push({
          ...correction,
          id: residual.id,
          eventId: residual.id,
          before,
          after: seg.text,
          reason: '已撤销先前修订；保留后续人工内容修改',
        });
        renderHandwriting(
          note,
          state.corrections[state.corrections.length - 1],
          seg.text,
          residual.id,
        );
        state.undoneRevisionIds.push(revisionId);
        return;
      }
    }
    for (const layer of layers) layer.deleted = true;
    state.corrections = state.corrections.filter((c) => c.id !== revisionId);
    state.undoneRevisionIds.push(revisionId);
  };
  for (const op of events) {
    checkOperation(op);
    const p = op.payload;
    state.events.push(op);
    if (op.type === 'note.create') {
      if (state.notes.some((n) => n.id === p.noteId)) continue;
      state.notes.push({
        id: p.noteId,
        title: p.title,
        pages: [makePaper(p.pageId, p.paper)],
        blocks: [],
        folderId: null,
        tags: [],
        createdAt: op.at,
        modifiedAt: op.at,
      });
      continue;
    }
    if (op.type === 'folder.create') {
      if (!state.folders.some((f) => f.id === p.id))
        state.folders.push({ id: p.id, name: p.name, subject: p.subject });
      continue;
    }
    if (op.type === 'setting.set') {
      if (!forbiddenKeys.has(p.key)) state.settings[p.key] = clone(p.value);
      continue;
    }
    const note = state.notes.find((n) => n.id === p.noteId);
    if (!note) throw new Error(`Operation ${op.id} refers to a missing note`);
    if (op.type === 'page.create') {
      if (!note.pages.some((x) => x.id === p.pageId)) note.pages.push(makePaper(p.pageId, p.paper));
    } else if (op.type === 'object.create') {
      const page = note.pages.find((x) => x.id === p.pageId);
      if (!page) throw new Error('Page not found');
      if (!objects(note).some((x) => x.id === p.object.id))
        page.objects.push({ ...clone(p.object), pageId: page.id, version: op.id });
    } else if (op.type === 'handwriting.learn') {
      const glyph = clone(p.glyph) as Omit<HandwritingGlyph, 'id'>;
      // Verify imported snapshots against their declared original vectors. Concurrent
      // edits can move the current object, so follow the immutable source-version chain.
      const sourceAtVersion = (id: string, version: string): PaperObject | undefined => {
        const current = objects(note).find(
          (o) => o.id === id && o.version === version && !o.deleted,
        );
        if (current) return current;
        let historical: PaperObject | undefined;
        for (const event of events) {
          if (
            event.clock >= op.clock ||
            event.payload.noteId !== note.id ||
            (op.seen?.[event.deviceId] ?? 0) < event.seq
          )
            continue;
          if (event.type === 'object.create' && event.payload.object.id === id)
            historical = {
              ...clone(event.payload.object),
              pageId: event.payload.pageId,
              version: event.id,
            };
          else if (historical && event.type === 'object.update' && event.payload.objectId === id) {
            const changes = event.payload.changes,
              base = event.payload.baseValues;
            if (
              historical.version === event.payload.baseVersion ||
              (base &&
                Object.keys(changes).every(
                  (k) =>
                    canonical((historical as any)[k]) === canonical(base[k]) ||
                    canonical((historical as any)[k]) === canonical(changes[k]),
                ))
            )
              Object.assign(historical, clone(changes), { version: event.id });
          } else if (historical && event.type === 'object.delete' && event.payload.objectId === id)
            historical.deleted = true;
        }
        return historical?.version === version && !historical.deleted ? historical : undefined;
      };
      const sources = Object.entries(glyph.sourceVersions).map(([id, version]) =>
        sourceAtVersion(id, version),
      );
      if (glyph.noteId !== note.id || sources.some((o) => !o))
        throw new Error('字形样本来源版本无效');
      const verified = captureHandwritingGlyph(glyph.character, note.id, sources as PaperObject[]);
      if (canonical(verified) !== canonical(glyph)) throw new Error('字形快照与声明的原始笔迹不符');
      state.handwritingGlyphs.push({ ...glyph, id: op.id });
      // A newly confirmed missing character can complete an existing printed fallback.
      for (const n of state.notes)
        for (const correction of state.corrections.filter(
          (c) => c.noteId === n.id && c.mode === 'printed',
        )) {
          const seg = lookup(state, n.id, correction.segmentId).segment;
          const live = objects(n).filter((o) => o.revisionId === correction.id && !o.deleted);
          if (
            seg?.source.status === 'exact' &&
            live.length &&
            live.every((o) => o.version === correction.handwritingVersion)
          )
            renderHandwriting(n, correction, seg.text, op.id);
        }
    } else if (op.type === 'revision.stroke.split') {
      applyStrokeSplit(op);
    } else if (op.type === 'revision.handwriting') {
      const correction = state.corrections.find((c) => c.id === p.revisionId);
      if (!correction || correction.needsPlacement) continue;
      const seg = lookup(state, note.id, correction.segmentId).segment;
      const live = objects(note).filter((o) => o.revisionId === correction.id && !o.deleted);
      const fingerprint = canonical({
        text: seg?.text,
        source: seg?.source,
        objects: live.map((o) => [o.id, o.version]),
      });
      if (!seg || fingerprint !== p.fingerprint || seg.source.status !== 'exact') continue;
      renderHandwriting(note, correction, seg.text, op.id);
    } else if (op.type === 'object.update') {
      const obj = objects(note).find((x) => x.id === p.objectId);
      if (!obj) throw new Error('Object not found');
      if (
        obj.version !== p.baseVersion &&
        (!p.baseValues ||
          Object.keys(p.changes).some(
            (k) =>
              canonical((obj as any)[k]) !== canonical(p.baseValues[k]) &&
              canonical((obj as any)[k]) !== canonical(p.changes[k]),
          ))
      )
        addConflict({
          id: op.id,
          kind: 'object',
          noteId: note.id,
          objectId: obj.id,
          current: JSON.stringify(obj.bounds),
          incoming: JSON.stringify(p.changes),
          currentEventId: obj.version,
          incomingEventId: op.id,
        });
      else {
        const changedPoints = p.changes.points as Point[] | undefined,
          dx = changedPoints && obj.points ? changedPoints[0]?.x - obj.points[0]?.x : 0,
          dy = changedPoints && obj.points ? changedPoints[0]?.y - obj.points[0]?.y : 0;
        const translated =
          !changedPoints ||
          (!!obj.points &&
            changedPoints.length === obj.points.length &&
            changedPoints.every((v, i) => {
              const old = obj.points![i];
              return (
                Math.abs(v.x - old.x - dx) < 1e-7 &&
                Math.abs(v.y - old.y - dy) < 1e-7 &&
                v.pressure === old.pressure &&
                v.tiltX === old.tiltX &&
                v.tiltY === old.tiltY &&
                v.time === old.time
              );
            }));
        const geometric = translated && p.changes.text === undefined;
        Object.assign(obj, clone(p.changes), { version: op.id });
        for (const block of note.blocks)
          for (const seg of block.segments)
            if (seg.source.objectIds.includes(obj.id)) {
              if (geometric) seg.source.objectVersions[obj.id] = op.id;
              else {
                seg.source.status = 'unmapped';
                seg.source.precision = 'none';
                seg.source.reason = '源对象内容已修改，等待重新识别与校对';
                for (const correction of state.corrections.filter((c) => c.segmentId === seg.id)) {
                  correction.needsPlacement = true;
                  correction.reason = '原稿已改变，保留 B 文字并等待重新校对；旧修订不再遮盖原稿';
                  for (const revision of objects(note).filter(
                    (o) => o.revisionId === correction.id,
                  ))
                    revision.deleted = true;
                }
              }
            }
      }
    } else if (op.type === 'object.delete') {
      const linkedIds = events
        .filter(
          (e) =>
            e.type === 'segment.create' &&
            e.payload.noteId === note.id &&
            e.payload.objectIds.includes(p.objectId),
        )
        .map((e) => e.payload.segmentId);
      const competing = events.find(
        (e) =>
          concurrent(op, e) &&
          e.payload.noteId === note.id &&
          ((e.type === 'object.update' && e.payload.objectId === p.objectId) ||
            (e.type === 'segment.edit' &&
              (e.payload.sourceObjectId === p.objectId ||
                linkedIds.includes(e.payload.segmentId)))),
      );
      const obj = objects(note).find((x) => x.id === p.objectId);
      if (competing) {
        addConflict({
          id: op.id,
          kind: 'object',
          noteId: note.id,
          objectId: p.objectId,
          current: obj?.text ?? '已修改的笔迹',
          incoming: '∅',
          currentEventId: competing.id,
          incomingEventId: op.id,
          deleteObjectId: p.objectId,
        });
        continue;
      }
      if (obj) obj.deleted = true;
      for (const block of note.blocks)
        for (const seg of block.segments)
          if (seg.source.objectIds.includes(p.objectId)) {
            for (const correction of state.corrections.filter((c) => c.segmentId === seg.id)) {
              for (const rev of objects(note).filter((o) => o.revisionId === correction.id))
                rev.deleted = true;
            }
            state.corrections = state.corrections.filter((c) => c.segmentId !== seg.id);
            if (seg.source.objectIds.length === 1) {
              seg.deleted = true;
              for (const ch of seg.chars) ch.deleted = true;
              refresh(seg);
            } else if (seg.source.precision === 'character') {
              for (const ch of seg.chars)
                if (ch.sourceObjectIds?.includes(p.objectId)) {
                  ch.deleted = true;
                  ch.version = op.id;
                }
              refresh(seg);
            } else {
              seg.source.status = 'unmapped';
              seg.source.precision = 'none';
              seg.source.reason = '部分源对象删除；保留文字等待校对';
            }
          }
    } else if (op.type === 'block.create') {
      if (!note.blocks.some((b) => b.id === p.blockId)) {
        const obs = objects(note).filter((o) => p.objectIds.includes(o.id));
        note.blocks.push({
          id: p.blockId,
          title: p.title,
          pageIds: [...new Set(obs.map((o) => o.pageId))],
          objectIds: clone(p.objectIds),
          segments: [],
          relatedBlockIds: [],
          versions: [],
        });
      }
    } else if (op.type === 'block.split' || op.type === 'block.merge') {
      applyStructure(op);
    } else if (op.type === 'block.link') {
      const block = note.blocks.find((b) => b.id === resolveAlias(state, p.blockId));
      const target = state.notes
        .flatMap((n) => n.blocks)
        .find((b) => b.id === resolveAlias(state, p.targetBlockId));
      if (!block || !target) throw new Error('Block not found');
      if (block.id === target.id) throw new Error('A block cannot link to itself');
      if (!block.relatedBlockIds.includes(target.id)) block.relatedBlockIds.push(target.id);
    } else if (op.type === 'segment.create') {
      const block = note.blocks.find((b) => b.id === resolveAlias(state, p.blockId));
      if (!block) throw new Error('Block not found');
      if (block.segments.some((s) => s.id === p.segmentId)) continue;
      const obs = objects(note).filter((o) => p.objectIds.includes(o.id) && !o.deleted);
      if (obs.length !== p.objectIds.length) throw new Error('Mapping references a missing object');
      const options = p.options as RecognitionOptions,
        exact = !!(options.confirmed || options.deterministic);
      const charMap = options.charMap ?? [];
      const values = Array.from(p.text as string);
      if (new Set(charMap.map((m) => m.index)).size !== charMap.length)
        throw new Error('Duplicate character mapping index');
      for (const m of charMap)
        if (
          !Number.isInteger(m.index) ||
          m.index < 0 ||
          m.index >= values.length ||
          !m.objectIds.length ||
          m.objectIds.some((id) => !p.objectIds.includes(id)) ||
          m.glyphIds?.some((id) => !m.objectIds.includes(id))
        )
          throw new Error('Invalid character mapping');
      const chars = values.map(
        (value, i): Character => ({
          id: `${op.id}:c${i}`,
          value,
          deleted: false,
          version: op.id,
          afterId: i ? `${op.id}:c${i - 1}` : null,
          order: `${String(op.clock).padStart(12, '0')}:${op.id}:${String(i).padStart(6, '0')}`,
          sourceObjectIds: exact ? charMap.find((m) => m.index === i)?.objectIds : undefined,
          glyphIds: exact ? charMap.find((m) => m.index === i)?.glyphIds : undefined,
        }),
      );
      const seg: Segment = {
        id: p.segmentId,
        blockId: block.id,
        kind: options.kind ?? 'text',
        chars,
        text: p.text,
        source: {
          status: exact ? 'exact' : 'unmapped',
          precision: exact
            ? charMap.length === values.length &&
              values.length > 0 &&
              charMap.every((m) => !!m.glyphIds?.length) &&
              new Set(charMap.flatMap((m) => m.glyphIds ?? [])).size ===
                charMap.flatMap((m) => m.glyphIds ?? []).length
              ? 'character'
              : 'object'
            : 'none',
          objectIds: clone(p.objectIds),
          reason: exact ? undefined : (options.reason ?? '识别结果尚未确认，不建立精确映射'),
          confidence: options.confidence ?? 0,
          evidence: options.deterministic
            ? 'deterministic'
            : options.confirmed
              ? 'user-confirmed'
              : 'unverified',
          objectVersions: Object.fromEntries(obs.map((o) => [o.id, o.version])),
        },
        preview: options.preview,
      };
      block.segments.push(seg);
      block.objectIds = [...new Set([...block.objectIds, ...p.objectIds])];
      block.pageIds = [...new Set([...block.pageIds, ...obs.map((o) => o.pageId)])];
      block.versions.push({ eventId: op.id, at: op.at, segmentId: seg.id, text: seg.text });
    } else if (op.type === 'segment.map') {
      const { segment: seg, block } = lookup(state, note.id, p.segmentId);
      if (!seg || seg.deleted) throw new Error('Segment not found');
      const obs = objects(note).filter((o) => p.objectIds.includes(o.id) && !o.deleted);
      if (!p.objectIds.length || obs.length !== p.objectIds.length)
        throw new Error('Mapping references missing source objects');
      const visible = seg.chars.filter((c) => !c.deleted),
        maps = (p.charMap ?? []) as NonNullable<RecognitionOptions['charMap']>;
      if (new Set(maps.map((m) => m.index)).size !== maps.length)
        throw new Error('Duplicate character mapping index');
      for (const m of maps)
        if (
          !Number.isInteger(m.index) ||
          m.index < 0 ||
          m.index >= visible.length ||
          !m.objectIds.length ||
          m.objectIds.some((id) => !p.objectIds.includes(id)) ||
          m.glyphIds?.some((id) => !m.objectIds.includes(id))
        )
          throw new Error('Invalid character mapping');
      for (const c of seg.chars) {
        delete c.sourceObjectIds;
        delete c.glyphIds;
      }
      for (const m of maps) {
        visible[m.index].sourceObjectIds = clone(m.objectIds);
        visible[m.index].glyphIds = m.glyphIds ? clone(m.glyphIds) : undefined;
      }
      seg.source = {
        status: 'exact',
        precision:
          maps.length === visible.length &&
          visible.length > 0 &&
          maps.every((m) => !!m.glyphIds?.length) &&
          new Set(maps.flatMap((m) => m.glyphIds ?? [])).size ===
            maps.flatMap((m) => m.glyphIds ?? []).length
            ? 'character'
            : 'object',
        objectIds: clone(p.objectIds),
        objectVersions: Object.fromEntries(obs.map((o) => [o.id, o.version])),
        confidence: 1,
        evidence: 'user-confirmed',
      };
      block!.objectIds = [...new Set([...block!.objectIds, ...p.objectIds])];
      block!.pageIds = [...new Set([...block!.pageIds, ...obs.map((o) => o.pageId)])];
    } else if (op.type === 'segment.edit' || op.type === 'segment.transcribe') {
      if (p.sourceObjectId && op.role !== 'tablet') throw new Error('A 只能由平板直接编辑');
      const { segment: seg, block } = lookup(state, note.id, p.segmentId);
      if (!seg || seg.deleted) throw new Error('Segment not found');
      const before = seg.text;
      const inverses: {
          charId: string;
          value: string;
          deleted: boolean;
          resultingVersion: string;
          sourceObjectIds?: string[];
          glyphIds?: string[];
        }[] = [],
        inserted: string[] = [];
      for (const patch of (p.patches ?? []) as CharPatch[]) {
        const ch = seg.chars.find((c) => c.id === patch.charId);
        if (!ch) throw new Error('Character not found');
        if (ch.version !== patch.baseVersion) {
          if (
            (patch.value === undefined || patch.value === ch.value) &&
            (patch.deleted === undefined || patch.deleted === ch.deleted)
          )
            continue;
          addConflict({
            id: `${op.id}:${ch.id}`,
            kind: 'character',
            noteId: note.id,
            segmentId: seg.id,
            charId: ch.id,
            current: ch.deleted ? '∅' : ch.value,
            incoming: patch.deleted ? '∅' : (patch.value ?? ch.value),
            currentEventId: ch.version,
            incomingEventId: op.id,
          });
          continue;
        }
        inverses.push({
          charId: ch.id,
          value: ch.value,
          deleted: ch.deleted,
          resultingVersion: op.id,
          sourceObjectIds: ch.sourceObjectIds ? clone(ch.sourceObjectIds) : undefined,
          glyphIds: ch.glyphIds ? clone(ch.glyphIds) : undefined,
        });
        if (patch.value !== undefined && patch.value !== ch.value) {
          ch.value = patch.value;
          delete ch.sourceObjectIds;
          delete ch.glyphIds;
          seg.source.precision = seg.source.status === 'exact' ? 'object' : 'none';
        }
        if (patch.deleted !== undefined) ch.deleted = patch.deleted;
        ch.version = op.id;
      }
      for (const ch of (p.inserts ?? []) as Character[]) {
        if (!seg.chars.some((c) => c.id === ch.id)) {
          seg.chars.push(clone(ch));
          inserted.push(ch.id);
        }
      }
      refresh(seg);
      if (inserted.length && seg.source.status === 'exact') seg.source.precision = 'object';
      if (op.type === 'segment.transcribe') {
        const ids = p.transcription.objectIds as string[],
          source = objects(note).filter((o) => ids.includes(o.id) && !o.deleted);
        if (source.length !== ids.length || !ids.length)
          throw new Error('Transcription source missing');
        const fresh =
          source.every((o) => p.transcription.sourceVersions[o.id] === o.version) &&
          !state.conflicts.some((c) => c.incomingEventId === op.id && !c.resolved);
        seg.source = {
          status: fresh ? 'exact' : 'unmapped',
          precision: fresh ? 'object' : 'none',
          objectIds: clone(ids),
          objectVersions: Object.fromEntries(source.map((o) => [o.id, o.version])),
          confidence: 1,
          evidence: fresh ? 'user-confirmed' : 'unverified',
          reason: fresh ? undefined : '校对期间内容发生并发修改，请核对候选和源对象',
        };
        for (const ch of seg.chars) {
          delete ch.sourceObjectIds;
          delete ch.glyphIds;
        }
        if (fresh) {
          for (const c of state.corrections.filter((c) => c.segmentId === seg.id)) {
            for (const obj of objects(note)) if (obj.revisionId === c.id) obj.deleted = true;
            state.undoneRevisionIds.push(c.id);
          }
          state.corrections = state.corrections.filter((c) => c.segmentId !== seg.id);
        }
      }
      if (before !== seg.text) {
        const obs = objects(note).filter((o) => seg.source.objectIds.includes(o.id) && !o.deleted);
        const page = note.pages.find((x) => x.id === obs[0]?.pageId) ?? note.pages[0];
        const revisionId = op.id,
          objectId = `revision:${op.id}`;
        // Exact source is required to place a revision. Unmapped text is retained for proofreading.
        if (op.type === 'segment.transcribe' || seg.kind === 'reference') {
          /* Description edits never replace the referenced native/visual object. */
        } else if (p.sourceObjectId) {
          const obj = objects(note).find((o) => o.id === p.sourceObjectId);
          if (obj) {
            obj.text = seg.text;
            obj.version = op.id;
            if (seg.source.objectIds.includes(obj.id)) seg.source.objectVersions[obj.id] = op.id;
          }
          for (const c of state.corrections.filter((c) => c.segmentId === seg.id)) {
            const rev = objects(note).find((o) => o.id === c.objectId && !o.deleted);
            if (rev) {
              rev.text = seg.text;
              rev.version = op.id;
              c.after = seg.text;
              renderHandwriting(note, c, seg.text, op.id);
            }
          }
        } else if (seg.source.status === 'exact' && obs.length) {
          for (const old of state.corrections.filter((c) => c.segmentId === seg.id)) {
            for (const obj of objects(note).filter((o) => o.revisionId === old.id))
              obj.deleted = true;
          }
          const sourcePages = [...new Set(obs.map((o) => o.pageId))],
            needsPlacement =
              sourcePages.length > 1 &&
              (seg.source.precision !== 'character' ||
                seg.chars.some((c) => !c.deleted && !c.sourceObjectIds?.length));
          const createdIds: string[] = [];
          if (needsPlacement) {
            // A multi-page object mapping says nothing about which characters belong on each page.
            // Keep the original visible and make the editable candidate explicit, never guess a split.
            page.objects.push({
              id: objectId,
              pageId: page.id,
              kind: seg.kind === 'formula' ? 'formula' : 'text',
              text: seg.text,
              layerId: `revision:${revisionId}`,
              bounds: {
                ...unionBounds(obs.filter((o) => o.pageId === page.id)),
                y: Math.min(
                  page.height - 100,
                  unionBounds(obs.filter((o) => o.pageId === page.id)).y +
                    unionBounds(obs.filter((o) => o.pageId === page.id)).height +
                    24,
                ),
              },
              revisionId,
              replacesObjectIds: [],
              version: op.id,
            });
            createdIds.push(objectId);
          } else
            for (const [index, pageId] of sourcePages.entries()) {
              const targetPage = note.pages.find((x) => x.id === pageId)!,
                localObs = obs.filter((o) => o.pageId === pageId),
                localIds = localObs.map((o) => o.id),
                localText =
                  sourcePages.length === 1
                    ? seg.text
                    : seg.chars
                        .filter(
                          (c) =>
                            !c.deleted && c.sourceObjectIds?.some((id) => localIds.includes(id)),
                        )
                        .map((c) => c.value)
                        .join('');
              const id = index === 0 ? objectId : `${objectId}:page${index}`;
              targetPage.objects.push({
                id,
                pageId,
                kind: seg.kind === 'formula' ? 'formula' : 'text',
                text: localText,
                layerId: `revision:${revisionId}`,
                bounds: unionBounds(localObs),
                revisionId,
                replacesObjectIds: localIds,
                version: op.id,
              });
              createdIds.push(id);
            }
          const correction: Correction = {
            id: revisionId,
            eventId: op.id,
            noteId: note.id,
            segmentId: seg.id,
            objectId,
            objectIds: createdIds,
            before,
            after: seg.text,
            mode: 'printed',
            status: 'pending',
            needsPlacement,
            reason: needsPlacement
              ? '跨页字符位置未确认；保留原稿与可编辑候选，须先校对定位'
              : '尚无已确认字形，保留可编辑印刷文字',
            ...(!needsPlacement && sourcePages.length === 1 && seg.kind === 'text'
              ? {
                  handwritingTarget: {
                    pageId: page.id,
                    bounds: unionBounds(obs),
                    replacesObjectIds: obs.map((o) => o.id),
                  },
                }
              : {}),
          };
          state.corrections.push(correction);
          renderHandwriting(note, correction, seg.text, op.id);
        }
        revisionChanges.set(op.id, {
          segmentId: seg.id,
          noteId: note.id,
          patches: inverses,
          inserted,
        });
        block!.versions.push({ eventId: op.id, at: op.at, segmentId: seg.id, text: seg.text });
      }
    } else if (op.type === 'segment.delete') {
      const { segment: seg } = lookup(state, note.id, p.segmentId);
      if (seg) {
        const competing = events.find(
          (e) => e.type === 'segment.edit' && e.payload.segmentId === seg.id && concurrent(op, e),
        );
        if (competing) {
          addConflict({
            id: op.id,
            kind: 'object',
            noteId: note.id,
            segmentId: seg.id,
            current: seg.text,
            incoming: '∅',
            currentEventId: competing.id,
            incomingEventId: op.id,
            deleteSegmentId: seg.id,
          });
          continue;
        }
        seg.deleted = true;
        for (const ch of seg.chars) ch.deleted = true;
        refresh(seg);
        if (seg.source.status === 'exact')
          for (const obj of objects(note))
            if (seg.source.objectIds.includes(obj.id)) obj.deleted = true;
        for (const correction of state.corrections.filter((c) => c.segmentId === seg.id))
          for (const obj of objects(note)) if (obj.revisionId === correction.id) obj.deleted = true;
        state.corrections = state.corrections.filter((c) => c.segmentId !== seg.id);
      }
    } else if (op.type === 'revision.undo') {
      if (state.mergedRevisionIds.includes(p.revisionId))
        throw new Error('Merged revisions cannot be independently undone');
      const change = revisionChanges.get(p.revisionId);
      if (!change) throw new Error('Revision not found');
      const { segment: seg, block } = lookup(state, note.id, change.segmentId);
      if (!seg) throw new Error('Segment not found');
      let dependencies = false;
      for (const inverse of change.patches) {
        const ch = seg.chars.find((c) => c.id === inverse.charId)!;
        if (ch.version !== inverse.resultingVersion) {
          dependencies = true;
          addConflict({
            id: `${op.id}:${ch.id}`,
            kind: 'dependency',
            noteId: note.id,
            segmentId: seg.id,
            charId: ch.id,
            current: ch.value,
            incoming: inverse.value,
            currentEventId: ch.version,
            incomingEventId: op.id,
            undoRevisionId: p.revisionId,
          });
        } else {
          ch.value = inverse.value;
          ch.deleted = inverse.deleted;
          ch.sourceObjectIds = inverse.sourceObjectIds;
          ch.glyphIds = inverse.glyphIds;
          ch.version = op.id;
        }
      }
      for (const id of change.inserted) {
        const ch = seg.chars.find((c) => c.id === id)!;
        if (ch.version !== p.revisionId) {
          dependencies = true;
          addConflict({
            id: `${op.id}:${id}`,
            kind: 'dependency',
            noteId: note.id,
            segmentId: seg.id,
            charId: id,
            current: ch.value,
            incoming: '∅',
            currentEventId: ch.version,
            incomingEventId: op.id,
            undoRevisionId: p.revisionId,
          });
        } else {
          ch.deleted = true;
          ch.version = op.id;
        }
      }
      refresh(seg);
      for (const c of state.corrections.filter(
        (c) => c.segmentId === seg.id && c.id !== p.revisionId,
      )) {
        const obj = objects(note).find((o) => o.id === c.objectId && !o.deleted);
        if (obj) {
          obj.text = seg.text;
          c.after = seg.text;
          renderHandwriting(note, c, seg.text, op.id);
        }
      }
      if (!dependencies) finishUndo(note, seg, p.revisionId);
      block!.versions.push({ eventId: op.id, at: op.at, segmentId: seg.id, text: seg.text });
    } else if (op.type === 'revision.merge') {
      if (!p.acknowledge) throw new Error('Explicit irreversible merge acknowledgement required');
      const correction = state.corrections.find((c) => c.id === p.revisionId);
      if (correction?.needsPlacement) throw new Error('跨页定位未校对，不能合并');
      const revisions = objects(note).filter((o) => o.revisionId === p.revisionId && !o.deleted);
      if (!revisions.length) throw new Error('Active revision not found');
      for (const rev of revisions) {
        for (const obj of objects(note))
          if (rev.replacesObjectIds?.includes(obj.id)) obj.deleted = true;
        delete rev.revisionId;
        delete rev.replacesObjectIds;
        rev.layerId = 'ink';
        rev.version = op.id;
      }
      const { segment: seg } = lookup(state, note.id, correction!.segmentId);
      if (seg) {
        seg.source.objectIds = revisions.map((o) => o.id);
        seg.source.objectVersions = Object.fromEntries(revisions.map((o) => [o.id, o.version]));
        seg.source.evidence = 'deterministic';
        for (const ch of seg.chars) {
          if (revisions.length === 1) ch.sourceObjectIds = [revisions[0].id];
          else ch.sourceObjectIds = undefined;
        }
        seg.source.precision = 'object';
      }
      state.corrections = state.corrections.filter((c) => c.id !== p.revisionId);
      state.mergedRevisionIds.push(p.revisionId);
      revisionChanges.delete(p.revisionId);
    } else if (op.type === 'conflict.resolve') {
      const conflict = state.conflicts.find((c) => c.id === p.conflictId);
      if (!conflict) throw new Error('Conflict not found');
      if ((conflict.kind === 'object' || conflict.kind === 'structure') && op.role !== 'tablet')
        throw new Error('A 对象冲突只能由平板解决');
      const obj = objects(note).find((o) => o.id === conflict.objectId),
        seg = conflict.segmentId ? lookup(state, note.id, conflict.segmentId).segment : undefined,
        ch = seg?.chars.find((c) => c.id === conflict.charId),
        version =
          conflict.kind === 'structure'
            ? structureFingerprint(note)
            : (ch?.version ?? obj?.version ?? seg?.chars.map((c) => c.version).join('|'));
      if (p.baseVersion !== version) {
        addConflict({
          ...clone(conflict),
          id: op.id,
          kind: conflict.kind === 'structure' ? 'structure' : ch ? 'dependency' : 'object',
          current: ch?.value ?? obj?.text ?? seg?.text ?? conflict.current,
          incoming: p.choice === 'incoming' ? conflict.incoming : conflict.current,
          currentEventId: ch?.version ?? obj?.version ?? op.id,
          incomingEventId:
            conflict.kind === 'structure' || conflict.kind === 'object'
              ? conflict.incomingEventId
              : op.id,
          resolved: false,
        });
        continue;
      }
      if (conflict.kind === 'structure') {
        if (p.choice === 'incoming') {
          const structural = events.find((e) => e.id === conflict.incomingEventId);
          if (!structural) throw new Error('Structural operation missing');
          applyStructure(structural, true);
        }
      } else if (conflict.kind === 'object') {
        if (p.choice === 'incoming' && (conflict.deleteObjectId || conflict.deleteSegmentId)) {
          if (obj) obj.deleted = true;
          const affected = conflict.deleteSegmentId
            ? note.blocks
                .flatMap((b) => b.segments)
                .filter((s) => s.id === conflict.deleteSegmentId)
            : note.blocks
                .flatMap((b) => b.segments)
                .filter((s) => s.source.objectIds.includes(conflict.deleteObjectId!));
          for (const s of affected) {
            s.deleted = true;
            for (const c of s.chars) c.deleted = true;
            refresh(s);
            for (const c of state.corrections.filter((c) => c.segmentId === s.id))
              for (const o of objects(note)) if (o.revisionId === c.id) o.deleted = true;
            state.corrections = state.corrections.filter((c) => c.segmentId !== s.id);
          }
        } else if (obj && p.choice === 'incoming') {
          const incoming = events.find((e) => e.id === conflict.incomingEventId);
          if (incoming?.type === 'revision.stroke.split') {
            if (!applyStrokeSplit({ ...incoming, id: op.id }, true))
              throw new Error('此修订已更新或合并，请在当前笔迹重新擦除');
          } else Object.assign(obj, clone(incoming?.payload.changes ?? {}), { version: op.id });
        }
      } else if (ch && seg) {
        const value = p.choice === 'incoming' ? conflict.incoming : conflict.current;
        ch.deleted = value === '∅';
        if (!ch.deleted) ch.value = value;
        ch.version = op.id;
        refresh(seg);
        const pending = state.corrections.filter((c) => c.segmentId === seg.id).at(-1);
        if (pending) {
          pending.after = seg.text;
          const rev = objects(note).find((o) => o.id === pending.objectId);
          if (rev) rev.text = seg.text;
          renderHandwriting(note, pending, seg.text, op.id);
        }
      }
      conflict.resolved = true;
      if (
        conflict.undoRevisionId &&
        seg &&
        !state.conflicts.some((c) => c.undoRevisionId === conflict.undoRevisionId && !c.resolved)
      )
        finishUndo(note, seg, conflict.undoRevisionId);
    } else if (op.type === 'note.manage') {
      if (p.title !== undefined) note.title = p.title;
      if (p.tags !== undefined) note.tags = clone(p.tags);
      if (p.folderId !== undefined) {
        if (p.folderId !== null && !state.folders.some((f) => f.id === p.folderId))
          throw new Error('Folder must already exist');
        note.folderId = p.folderId;
      }
    }
    if (!['note.manage', 'conflict.resolve'].includes(op.type))
      note.modifiedAt = Math.max(note.modifiedAt, op.at);
  }
  return state;
}

export class NotebookEngine {
  project: Project;
  readonly deviceId: string;
  readonly role: Role;
  private cached?: NotebookState;
  constructor(project?: Project, deviceId = 'local', role: Role = 'tablet') {
    this.project = project
      ? clone(project)
      : { schemaVersion: 1, id: uid(), operations: [], metadata: {} };
    if (
      this.project.schemaVersion !== 1 ||
      typeof this.project.id !== 'string' ||
      !this.project.id ||
      !Array.isArray(this.project.operations) ||
      !this.project.metadata ||
      typeof this.project.metadata !== 'object' ||
      Array.isArray(this.project.metadata)
    )
      throw new Error('Invalid or unsupported project schema');
    if (new Set(this.project.operations.map((op) => op.id)).size !== this.project.operations.length)
      throw new Error('Duplicate operation identity');
    this.deviceId = deviceId;
    this.role = role;
    this.cached = projectState(this.project);
  }
  get state(): NotebookState {
    return (this.cached ??= projectState(this.project));
  }
  private append(type: string, payload: Record<string, any>): Operation {
    if (tabletOnly.has(type) && this.role !== 'tablet') throw new Error('此操作仅限 Android 平板');
    const seq =
      Math.max(
        0,
        ...this.project.operations.filter((o) => o.deviceId === this.deviceId).map((o) => o.seq),
      ) + 1;
    const clock = Math.max(0, ...this.project.operations.map((o) => o.clock)) + 1;
    const op: Operation = {
      id: `${this.deviceId}:${seq}:${uid()}`,
      deviceId: this.deviceId,
      role: this.role,
      seq,
      clock,
      at: Date.now(),
      type,
      payload: clone(payload),
      seen: observed(this.project.operations),
    };
    const candidate = { ...this.project, operations: [...this.project.operations, op] };
    // Ink append cannot invalidate another object: keep pointer-up work proportional to this stroke.
    // Full deterministic replay remains the verifier for imports, remote merges and semantic edits.
    if (type === 'object.create') {
      checkOperation(op);
      const prior = this.state,
        note = prior.notes.find((n) => n.id === payload.noteId),
        page = note?.pages.find((p) => p.id === payload.pageId);
      if (!note || !page) throw new Error('Page not found');
      if (objects(note).some((o) => o.id === payload.object.id))
        throw new Error('Duplicate object identity');
      const object: PaperObject = { ...clone(payload.object), pageId: page.id, version: op.id };
      const nextPage = { ...page, objects: [...page.objects, object] },
        nextNote = {
          ...note,
          pages: note.pages.map((p) => (p.id === page.id ? nextPage : p)),
          modifiedAt: Math.max(note.modifiedAt, op.at),
        };
      this.project = candidate;
      this.cached = {
        ...prior,
        notes: prior.notes.map((n) => (n.id === note.id ? nextNote : n)),
        events: [...prior.events, op],
      };
      return op;
    }
    const state = projectState(candidate);
    this.project = candidate;
    this.cached = state;
    return op;
  }
  getNote(noteId: string): Note {
    return lookup(this.state, noteId).note;
  }
  createNote(title = '未命名笔记', paper: PaperSpec = {}): string {
    const noteId = uid(),
      pageId = uid();
    this.append('note.create', { noteId, pageId, title, paper });
    return noteId;
  }
  addPage(noteId: string, paper: PaperSpec = {}): string {
    const pageId = uid();
    this.append('page.create', { noteId, pageId, paper });
    return pageId;
  }
  addStroke(
    noteId: string,
    pageId: string,
    points: Point[],
    options: { color?: string; width?: number; layerId?: string; draftId?: string } = {},
  ): string {
    if (options.draftId) {
      const existing = this.project.operations.find(
        (op) =>
          op.type === 'object.create' &&
          op.payload.noteId === noteId &&
          op.payload.pageId === pageId &&
          op.payload.draftId === options.draftId,
      );
      if (existing) return existing.payload.object.id;
    }
    if (
      !points.length ||
      points.some((p) => ![p.x, p.y, p.pressure, p.tiltX, p.tiltY, p.time].every(Number.isFinite))
    )
      throw new Error('Invalid stroke samples');
    const x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y));
    const objectId = uid();
    this.append('object.create', {
      noteId,
      pageId,
      ...(options.draftId ? { draftId: options.draftId } : {}),
      object: {
        id: objectId,
        kind: 'stroke',
        points: clone(points),
        layerId: options.layerId ?? 'ink',
        color: options.color ?? '#302d36',
        width: options.width ?? 2.4,
        bounds: {
          x,
          y,
          width: Math.max(1, Math.max(...points.map((p) => p.x)) - x),
          height: Math.max(1, Math.max(...points.map((p) => p.y)) - y),
        },
      },
    });
    return objectId;
  }
  /** Atomically split a generated stroke while keeping every residual in its revision. */
  splitRevisionStroke(
    noteId: string,
    objectId: string,
    keptFragments: Point[][],
    expectedVersion?: string,
  ): string[] {
    if (this.role !== 'tablet') throw new Error('此操作仅限 Android 平板');
    const source = objects(this.getNote(noteId)).find((o) => o.id === objectId && !o.deleted);
    if (
      !source ||
      source.kind !== 'stroke' ||
      !source.revisionId ||
      !this.state.corrections.some((c) => c.id === source.revisionId)
    )
      throw new Error('Active revision stroke not found');
    if (expectedVersion !== undefined && expectedVersion !== source.version)
      throw new Error('修订笔迹已改变，请刷新后重试');
    const fragments = keptFragments.map((points, index) => ({
      id: index === 0 ? source.id : uid(),
      points,
    }));
    this.append('revision.stroke.split', {
      noteId,
      objectId,
      revisionId: source.revisionId,
      baseVersion: source.version,
      fragments,
    });
    return fragments.map((part) => part.id);
  }
  addText(
    noteId: string,
    pageId: string,
    text: string,
    bounds: Bounds = { x: 60, y: 80, width: 600, height: 48 },
    kind: 'text' | 'formula' = 'text',
  ): string {
    const objectId = uid();
    this.append('object.create', {
      noteId,
      pageId,
      object: { id: objectId, kind, text, bounds, layerId: 'ink' },
    });
    return objectId;
  }
  addImage(
    noteId: string,
    pageId: string,
    data: string,
    bounds: Bounds = { x: 60, y: 80, width: 400, height: 280 },
  ): string {
    const objectId = uid();
    this.append('object.create', {
      noteId,
      pageId,
      object: { id: objectId, kind: 'image', data, bounds, layerId: 'ink' },
    });
    return objectId;
  }
  updateObject(
    noteId: string,
    objectId: string,
    changes: Partial<
      Pick<PaperObject, 'bounds' | 'points' | 'text' | 'color' | 'width' | 'layerId'>
    >,
  ): void {
    const obj = objects(this.getNote(noteId)).find((o) => o.id === objectId && !o.deleted);
    if (!obj) throw new Error('Object not found');
    if (this.role !== 'tablet') throw new Error('此操作仅限 Android 平板');
    if (changes.text !== undefined) {
      const pending = this.state.corrections.find(
        (c) => c.objectId === objectId || c.objectIds?.includes(objectId),
      );
      const seg = this.getNote(noteId)
        .blocks.flatMap((b) => b.segments)
        .find(
          (s) =>
            !s.deleted &&
            s.source.status === 'exact' &&
            ((s.source.objectIds.length === 1 && s.source.objectIds[0] === objectId) ||
              s.id === pending?.segmentId),
        );
      if (seg) {
        this.editSegment(noteId, seg.id, changes.text, objectId);
        const rest = { ...changes };
        delete rest.text;
        if (Object.keys(rest).length) this.updateObject(noteId, objectId, rest);
        return;
      }
    }
    if (changes.bounds && !Object.values(changes.bounds).every(Number.isFinite))
      throw new Error('Invalid bounds');
    this.append('object.update', {
      noteId,
      objectId,
      baseVersion: obj.version,
      baseValues: Object.fromEntries(
        Object.keys(changes).map((k) => [k, clone((obj as any)[k] ?? null)]),
      ),
      changes,
    });
  }
  deleteObject(noteId: string, objectId: string): void {
    this.append('object.delete', { noteId, objectId });
  }
  createBlock(noteId: string, title = '未命名知识块', objectIds: string[] = []): string {
    const note = this.getNote(noteId);
    if (objectIds.some((id) => !objects(note).some((o) => o.id === id && !o.deleted)))
      throw new Error('Unknown source object');
    const blockId = uid();
    this.append('block.create', { noteId, blockId, title, objectIds });
    return blockId;
  }
  resolveBlockId(id: string): string {
    return resolveAlias(this.state, id);
  }
  splitBlock(noteId: string, blockId: string, segmentIds: string[], newTitle = '新知识块'): string {
    if (this.role !== 'tablet') throw new Error('知识块结构操作仅限 Android 平板');
    const source = this.getNote(noteId).blocks.find((b) => b.id === this.resolveBlockId(blockId));
    if (!source) throw new Error('Block not found');
    const selected = [...new Set(segmentIds)],
      available = source.segments.filter((s) => !s.deleted);
    if (
      !selected.length ||
      selected.length >= available.length ||
      selected.some((id) => !available.some((s) => s.id === id))
    )
      throw new Error('请选择非空的部分段落拆分');
    const newBlockId = uid();
    this.append('block.split', {
      noteId,
      blockId: source.id,
      newBlockId,
      title: newTitle,
      segmentIds: source.segments.filter((s) => selected.includes(s.id)).map((s) => s.id),
      baseSegmentIds: source.segments.map((s) => s.id),
    });
    return newBlockId;
  }
  mergeBlocks(noteId: string, blockIds: string[], title?: string): string {
    if (this.role !== 'tablet') throw new Error('知识块结构操作仅限 Android 平板');
    const ids = [...new Set(blockIds.map((id) => this.resolveBlockId(id)))];
    if (ids.length < 2) throw new Error('请选择至少两个知识块合并');
    const note = this.getNote(noteId);
    if (ids.some((id) => !note.blocks.some((b) => b.id === id)))
      throw new Error('Merge block not found');
    this.append('block.merge', {
      noteId,
      blockIds: ids,
      title: title ?? note.blocks.find((b) => b.id === ids[0])!.title,
    });
    return ids[0];
  }
  linkBlocks(noteId: string, blockId: string, targetBlockId: string): void {
    this.append('block.link', { noteId, blockId, targetBlockId });
  }
  recognize(
    noteId: string,
    blockId: string,
    objectIds: string[],
    text: string,
    options: RecognitionOptions = {},
  ): string {
    if (!objectIds.length) throw new Error('Recognition requires source objects');
    const segmentId = uid();
    this.append('segment.create', { noteId, blockId, segmentId, objectIds, text, options });
    return segmentId;
  }
  /** Correct a transcription of the paper, not the paper itself. Original A objects never change. */
  correctTranscription(
    noteId: string,
    segmentId: string,
    text: string,
    objectIds: string[],
  ): string {
    if (this.role !== 'tablet') throw new Error('校对原稿仅限 Android 平板');
    const { segment: seg } = lookup(this.state, noteId, segmentId);
    if (!seg || seg.deleted) throw new Error('Segment not found');
    const note = this.getNote(noteId),
      source = objects(note).filter((o) => objectIds.includes(o.id) && !o.deleted);
    if (!objectIds.length || source.length !== objectIds.length)
      throw new Error('Transcription source missing');
    const visible = seg.chars.filter((c) => !c.deleted),
      values = Array.from(text),
      patches: CharPatch[] = [],
      insertValues: { afterId: string | null; value: string; tempId: string }[] = [];
    let previous: string | null = null;
    for (let i = 0; i < Math.max(visible.length, values.length); i++) {
      if (i < visible.length && i < values.length) {
        if (visible[i].value !== values[i])
          patches.push({
            charId: visible[i].id,
            value: values[i],
            baseVersion: visible[i].version,
          });
        previous = visible[i].id;
      } else if (i < visible.length)
        patches.push({ charId: visible[i].id, deleted: true, baseVersion: visible[i].version });
      else {
        const tempId = `$insert${insertValues.length}`;
        insertValues.push({ afterId: previous, value: values[i], tempId });
        previous = tempId;
      }
    }
    return this.applyCharEdits(noteId, segmentId, patches, insertValues, undefined, {
      objectIds,
      sourceVersions: Object.fromEntries(source.map((o) => [o.id, o.version])),
    });
  }
  confirmMapping(
    noteId: string,
    segmentId: string,
    objectIds: string[],
    charMap?: RecognitionOptions['charMap'],
  ): void {
    this.append('segment.map', { noteId, segmentId, objectIds, ...(charMap ? { charMap } : {}) });
  }
  editSegment(
    noteId: string,
    segmentId: string,
    text: string,
    sourceObjectId?: string,
  ): string | undefined {
    if (sourceObjectId && this.role !== 'tablet') throw new Error('此操作仅限 Android 平板');
    const seg = lookup(this.state, noteId, segmentId).segment;
    if (!seg || seg.deleted) throw new Error('Segment not found');
    if (seg.text === text) return;
    const old = seg.chars.filter((c) => !c.deleted),
      next = Array.from(text),
      patches: CharPatch[] = [],
      insertValues: { afterId: string | null; value: string; tempId: string }[] = [];
    if (old.length !== next.length) {
      const before = old.map((c) => c.value),
        short = before.length > next.length ? next : before,
        long = before.length > next.length ? before : next,
        delta = long.length - short.length;
      let candidates = 0;
      for (let i = 0; i <= short.length; i++)
        if (
          long
            .slice(0, i)
            .concat(long.slice(i + delta))
            .join('') === short.join('')
        )
          candidates++;
      if (candidates > 1)
        throw new Error(
          '重复符号的编辑范围不明确，请使用 editRange 或 editCharacters 保留字符身份',
        );
    }
    let prefix = 0;
    while (prefix < old.length && prefix < next.length && old[prefix].value === next[prefix])
      prefix++;
    let suffix = 0;
    while (
      suffix < old.length - prefix &&
      suffix < next.length - prefix &&
      old[old.length - 1 - suffix].value === next[next.length - 1 - suffix]
    )
      suffix++;
    const a = old.slice(prefix, old.length - suffix),
      b = next.slice(prefix, next.length - suffix);
    let previous = prefix ? old[prefix - 1].id : null,
      insertIndex = 0;
    const insert = (value: string) => {
      const tempId = `$insert${insertIndex++}`;
      insertValues.push({ afterId: previous, value, tempId });
      previous = tempId;
    };
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) {
        if (a[i].value !== b[i])
          patches.push({ charId: a[i].id, value: b[i], baseVersion: a[i].version });
        previous = a[i].id;
      }
    } else if (a.length * b.length <= 250000) {
      const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
      for (let i = a.length; i >= 0; i--)
        for (let j = b.length; j >= 0; j--) {
          if (i === a.length) dp[i][j] = b.length - j;
          else if (j === b.length) dp[i][j] = a.length - i;
          else
            dp[i][j] = Math.min(
              dp[i + 1][j] + 1,
              dp[i][j + 1] + 1,
              dp[i + 1][j + 1] + (a[i].value === b[j] ? 0 : 1),
            );
        }
      let i = 0,
        j = 0;
      while (i < a.length || j < b.length) {
        if (
          i < a.length &&
          j < b.length &&
          dp[i][j] === dp[i + 1][j + 1] + (a[i].value === b[j] ? 0 : 1)
        ) {
          if (a[i].value !== b[j])
            patches.push({ charId: a[i].id, value: b[j], baseVersion: a[i].version });
          previous = a[i].id;
          i++;
          j++;
        } else if (j < b.length && dp[i][j] === dp[i][j + 1] + 1) {
          insert(b[j++]);
        } else {
          patches.push({ charId: a[i].id, deleted: true, baseVersion: a[i].version });
          i++;
        }
      }
    } else {
      for (const ch of a) patches.push({ charId: ch.id, deleted: true, baseVersion: ch.version });
      for (const value of b) insert(value);
    }
    return this.applyCharEdits(noteId, segmentId, patches, insertValues, sourceObjectId);
  }
  /** Use this for a concrete editor selection: indexes count Unicode codepoints, not UTF-16 units. */
  editRange(
    noteId: string,
    segmentId: string,
    start: number,
    end: number,
    replacement: string,
  ): string | undefined {
    const seg = lookup(this.state, noteId, segmentId).segment;
    if (!seg || seg.deleted) throw new Error('Segment not found');
    const visible = seg.chars.filter((c) => !c.deleted);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > visible.length
    )
      throw new Error('Invalid character range');
    const removed = visible.slice(start, end),
      values = Array.from(replacement),
      patches: CharPatch[] = [],
      insertValues: { afterId: string | null; value: string; tempId: string }[] = [];
    let previous = start ? visible[start - 1].id : null;
    for (let i = 0; i < Math.max(removed.length, values.length); i++) {
      if (i < removed.length && i < values.length) {
        if (removed[i].value !== values[i])
          patches.push({
            charId: removed[i].id,
            value: values[i],
            baseVersion: removed[i].version,
          });
        previous = removed[i].id;
      } else if (i < removed.length)
        patches.push({ charId: removed[i].id, deleted: true, baseVersion: removed[i].version });
      else {
        const tempId = `$insert${insertValues.length}`;
        insertValues.push({ afterId: previous, value: values[i], tempId });
        previous = tempId;
      }
    }
    if (!patches.length && !insertValues.length) return;
    return this.applyCharEdits(noteId, segmentId, patches, insertValues);
  }
  /** Stable-id API for symbol-aware editors, independent of visual positions. */
  editCharacters(
    noteId: string,
    segmentId: string,
    changes: { id: string; value?: string; deleted?: boolean; baseVersion?: string }[],
    inserts: { afterId: string | null; value: string }[] = [],
  ): string {
    const seg = lookup(this.state, noteId, segmentId).segment;
    if (!seg || seg.deleted) throw new Error('Segment not found');
    const patches = changes.map((c) => {
      const char = seg.chars.find((x) => x.id === c.id);
      if (!char) throw new Error('Character not found');
      if (c.value !== undefined && Array.from(c.value).length !== 1)
        throw new Error('Each character edit must contain one Unicode codepoint');
      return {
        charId: c.id,
        ...(c.value !== undefined ? { value: c.value } : {}),
        ...(c.deleted !== undefined ? { deleted: c.deleted } : {}),
        baseVersion: c.baseVersion ?? char.version,
      };
    });
    const insertValues = inserts.map((v, i) => {
      if (v.afterId !== null && !seg.chars.some((c) => c.id === v.afterId))
        throw new Error('Insertion anchor not found');
      if (Array.from(v.value).length !== 1)
        throw new Error('Each inserted value must contain one Unicode codepoint');
      return { afterId: v.afterId, value: v.value, tempId: `$insert${i}` };
    });
    return this.applyCharEdits(noteId, segmentId, patches, insertValues);
  }
  private applyCharEdits(
    noteId: string,
    segmentId: string,
    patches: CharPatch[],
    insertValues: { afterId: string | null; value: string; tempId: string }[],
    sourceObjectId?: string,
    transcription?: { objectIds: string[]; sourceVersions: Record<string, string> },
  ): string {
    const seq =
        Math.max(
          0,
          ...this.project.operations.filter((o) => o.deviceId === this.deviceId).map((o) => o.seq),
        ) + 1,
      clock = Math.max(0, ...this.project.operations.map((o) => o.clock)) + 1;
    const opId = `${this.deviceId}:${seq}:${uid()}`;
    const idMap = new Map(insertValues.map((x, i) => [x.tempId, `${opId}:insert${i}`]));
    const inserts = insertValues.map(
      (x, i): Character => ({
        id: idMap.get(x.tempId)!,
        value: x.value,
        deleted: false,
        version: opId,
        afterId: x.afterId?.startsWith('$insert') ? idMap.get(x.afterId)! : x.afterId,
        order: `${String(clock).padStart(12, '0')}:${opId}:${String(i).padStart(6, '0')}`,
      }),
    );
    const op: Operation = {
      id: opId,
      deviceId: this.deviceId,
      role: this.role,
      seq,
      clock,
      at: Date.now(),
      seen: observed(this.project.operations),
      type: transcription ? 'segment.transcribe' : 'segment.edit',
      payload: {
        noteId,
        segmentId,
        patches,
        inserts,
        ...(sourceObjectId ? { sourceObjectId } : {}),
        ...(transcription ? { transcription } : {}),
      },
    };
    const candidate = { ...this.project, operations: [...this.project.operations, op] };
    const state = projectState(candidate);
    this.project = candidate;
    this.cached = state;
    return op.id;
  }
  correctTypo(
    noteId: string,
    segmentId: string,
    text: string,
    confidence: number,
    rule?: { id: string; from: string; to: string; contentKind: 'prose'; authorized: boolean },
  ): string | undefined {
    const seg = lookup(this.state, noteId, segmentId).segment;
    if (!seg || seg.kind !== 'text')
      throw new Error('Formula and knowledge facts must never be automatically corrected');
    if (confidence < 0.995)
      throw new Error('Automatic typo correction requires confidence ≥ 0.995');
    if (
      !rule?.authorized ||
      rule.contentKind !== 'prose' ||
      !rule.id ||
      !rule.from ||
      seg.text.replace(rule.from, rule.to) !== text
    )
      throw new Error(
        'Automatic correction requires a reviewed orthographic rule and prose authorization',
      );
    return this.editSegment(noteId, segmentId, text);
  }
  deleteSegment(noteId: string, segmentId: string): void {
    this.append('segment.delete', { noteId, segmentId });
  }
  /** Register only a character explicitly confirmed by the writer. Source vectors are snapshotted. */
  learnHandwritingGlyph(
    noteId: string,
    objectIds: string[],
    character: string,
    expectedVersions?: Record<string, string>,
  ): string {
    if (this.role !== 'tablet') throw new Error('此操作仅限 Android 平板');
    const source = objectIds.map((id) =>
      objects(this.getNote(noteId)).find((o) => o.id === id && !o.deleted),
    );
    if (source.some((o) => !o)) throw new Error('字形来源已删除');
    if (expectedVersions && source.some((o) => expectedVersions[o!.id] !== o!.version))
      throw new Error('字形来源已改变，请重新核对');
    const glyph = captureHandwritingGlyph(character, noteId, source as PaperObject[]);
    return this.append('handwriting.learn', { noteId, glyph }).id;
  }
  /** Capture this token when opening a retry preview; a stale token cannot replace newer ink. */
  handwritingRevisionFingerprint(revisionId: string): string {
    const correction = this.state.corrections.find((c) => c.id === revisionId);
    if (!correction) throw new Error('Revision not found');
    const note = this.getNote(correction.noteId),
      seg = lookup(this.state, note.id, correction.segmentId).segment;
    const live = objects(note).filter((o) => o.revisionId === correction.id && !o.deleted);
    return canonical({
      text: seg?.text,
      source: seg?.source,
      objects: live.map((o) => [o.id, o.version]),
    });
  }
  retryHandwritingRevision(revisionId: string, expectedFingerprint?: string): void {
    const correction = this.state.corrections.find((c) => c.id === revisionId);
    if (!correction) throw new Error('Revision not found');
    const seg = lookup(this.state, correction.noteId, correction.segmentId).segment;
    if (
      correction.needsPlacement ||
      !correction.handwritingTarget ||
      seg?.source.status !== 'exact'
    )
      throw new Error('来源或落点未确认，不能生成仿手写');
    const fingerprint = this.handwritingRevisionFingerprint(revisionId);
    if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint)
      throw new Error('修订已改变，请刷新后重试');
    this.append('revision.handwriting', { noteId: correction.noteId, revisionId, fingerprint });
  }
  undoRevision(revisionId: string): void {
    if (this.state.mergedRevisionIds.includes(revisionId))
      throw new Error('合并后不能独立撤销此修订');
    if (this.state.undoneRevisionIds.includes(revisionId))
      throw new Error('Revision already undone');
    if (this.state.conflicts.some((c) => c.undoRevisionId === revisionId && !c.resolved))
      throw new Error('请先解决此撤销的依赖冲突');
    const correction = this.state.corrections.find((c) => c.id === revisionId);
    if (!correction) throw new Error('Revision not found');
    this.append('revision.undo', { noteId: correction.noteId, revisionId });
  }
  mergeRevision(revisionId: string, acknowledge = false): void {
    if (this.state.conflicts.some((c) => c.undoRevisionId === revisionId && !c.resolved))
      throw new Error('请先解决此撤销的依赖冲突');
    if (!acknowledge) throw new Error('合并不可逆：将清除修订来源和专用撤销记录，请明确确认');
    const correction = this.state.corrections.find((c) => c.id === revisionId);
    if (!correction) throw new Error('Revision not found');
    this.append('revision.merge', { noteId: correction.noteId, revisionId, acknowledge });
  }
  resolveConflict(conflictId: string, choice: 'current' | 'incoming'): void {
    const conflict = this.state.conflicts.find((c) => c.id === conflictId && !c.resolved);
    if (!conflict) throw new Error('Unresolved conflict not found');
    if ((conflict.kind === 'object' || conflict.kind === 'structure') && this.role !== 'tablet')
      throw new Error('A 对象冲突只能由平板解决');
    const note = this.getNote(conflict.noteId);
    const obj = objects(note).find((o) => o.id === conflict.objectId),
      seg = conflict.segmentId
        ? lookup(this.state, note.id, conflict.segmentId).segment
        : undefined,
      ch = seg?.chars.find((c) => c.id === conflict.charId);
    const baseVersion =
      conflict.kind === 'structure'
        ? structureFingerprint(note)
        : (ch?.version ?? obj?.version ?? seg?.chars.map((c) => c.version).join('|'));
    this.append('conflict.resolve', { noteId: conflict.noteId, conflictId, choice, baseVersion });
  }
  manageNote(
    noteId: string,
    changes: { title?: string; folderId?: string | null; tags?: string[] },
  ): void {
    this.append('note.manage', { noteId, ...changes });
  }
  createFolder(name: string, subject?: string): string {
    const id = uid();
    this.append('folder.create', { id, name, subject });
    return id;
  }
  setSetting(key: string, value: unknown): void {
    if (forbiddenKeys.has(key)) throw new Error('Invalid setting key');
    this.append('setting.set', { key, value });
  }
  merge(remote: Project): void {
    if (remote.id !== this.project.id || remote.schemaVersion !== 1)
      throw new Error('Cannot merge unrelated projects');
    const byId = new Map(this.project.operations.map((o) => [o.id, o]));
    for (const op of remote.operations) {
      checkOperation(op);
      const old = byId.get(op.id);
      if (old && canonical(old) !== canonical(op)) throw new Error('Operation identity collision');
      if (!old) byId.set(op.id, clone(op));
    }
    const candidate = { ...this.project, operations: [...byId.values()] };
    const state = projectState(candidate);
    this.project = candidate;
    this.cached = state;
  }
  validateMappings(): { segmentId: string; valid: boolean; reason?: string }[] {
    return this.state.notes.flatMap((note) =>
      note.blocks.flatMap((block) =>
        block.segments.map((seg) => {
          if (seg.source.status !== 'exact')
            return { segmentId: seg.id, valid: false, reason: seg.source.reason ?? 'Unmapped' };
          const obs = objects(note);
          const valid = seg.source.objectIds.every((id) =>
            obs.some(
              (o) => o.id === id && (o.version === seg.source.objectVersions[id] || o.deleted),
            ),
          );
          return { segmentId: seg.id, valid, reason: valid ? undefined : 'Source version changed' };
        }),
      ),
    );
  }
  findCorrespondence(
    noteId: string,
    id: string,
  ): {
    status: 'exact' | 'unmapped';
    objectIds: string[];
    segmentIds: string[];
    charIds: string[];
    reason?: string;
    originalSourceIds?: string[];
    precision?: 'character' | 'object' | 'none';
  } {
    const note = this.getNote(noteId),
      segments = note.blocks.flatMap((b) => b.segments).filter((s) => !s.deleted);
    const correction = this.state.corrections.find(
      (c) => c.objectId === id || c.objectIds?.includes(id),
    );
    const matches = segments.filter(
      (s) =>
        s.id === id ||
        s.source.objectIds.includes(id) ||
        s.chars.some((c) => c.id === id) ||
        s.id === correction?.segmentId,
    );
    if (!matches.length)
      return {
        status: 'unmapped',
        objectIds: [],
        segmentIds: [],
        charIds: [],
        reason: '尚无经过验证的对应关系',
      };
    const exact = matches.every((s) => s.source.status === 'exact');
    const originalSourceIds = [...new Set(matches.flatMap((s) => s.source.objectIds))],
      active = matches.flatMap((s) => {
        const pending = this.state.corrections
          .filter((c) => c.segmentId === s.id)
          .filter((c) => objects(note).some((o) => o.revisionId === c.id && !o.deleted))
          .at(-1);
        return pending && !pending.needsPlacement
          ? (pending.objectIds ?? [pending.objectId])
          : s.source.objectIds;
      });
    return {
      status: exact ? 'exact' : 'unmapped',
      precision: exact
        ? active.some((id) => id.startsWith('revision:'))
          ? 'object'
          : matches.every((s) => s.source.precision === 'character')
            ? 'character'
            : 'object'
        : 'none',
      objectIds: [...new Set(active)],
      originalSourceIds,
      segmentIds: matches.map((s) => s.id),
      charIds: matches.flatMap((s) =>
        s.chars
          .filter((c) => !c.deleted && (c.id === id || c.sourceObjectIds?.includes(id)))
          .map((c) => c.id),
      ),
      reason: exact ? undefined : matches.find((s) => s.source.status !== 'exact')?.source.reason,
    };
  }
  exportProject(): string {
    return JSON.stringify(
      { format: 'quiet-paper-project', version: 1, project: this.project },
      null,
      2,
    );
  }
  static importProject(json: string): Project {
    const parsed = JSON.parse(json);
    if (
      parsed.format !== 'quiet-paper-project' ||
      parsed.version !== 1 ||
      parsed.project?.schemaVersion !== 1 ||
      !Array.isArray(parsed.project.operations)
    )
      throw new Error('Invalid or unsupported project package');
    const engine = new NotebookEngine(parsed.project);
    return clone(engine.project);
  }
}
