import type { Correction, Note, NotebookState, Operation, PaperObject, Segment } from './domain';

export const PAPER_ACTION_TYPES = new Set([
  'object.create',
  'object.update',
  'object.delete',
  'revision.stroke.split',
]);

export type PaperState = { objects: PaperObject[]; segments: Segment[]; corrections: Correction[] };
export type PaperUndo = {
  operation: Operation;
  actions: Operation[];
  objectIds: Set<string>;
  before?: PaperState;
  after?: PaperState;
};

export function collectPaperUndos(events: Operation[], validate: (operation: Operation) => void) {
  const first = new Map<string, PaperUndo[]>();
  const last = new Map<string, PaperUndo[]>();
  const undos = new Map<string, PaperUndo>();
  if (!events.some((event) => event.type === 'paper.undo')) return { first, last, undos };
  const byId = new Map(events.map((event) => [event.id, event]));
  const register = (map: Map<string, PaperUndo[]>, id: string, undo: PaperUndo) =>
    map.set(id, [...(map.get(id) ?? []), undo]);
  for (const operation of events) {
    if (operation.type !== 'paper.undo') continue;
    validate(operation);
    const actions = (operation.payload.actionIds as string[]).map((id) => byId.get(id));
    if (
      !actions.every(
        (action, index): action is Operation =>
          !!action &&
          action.deviceId === operation.deviceId &&
          action.role === 'tablet' &&
          action.payload.noteId === operation.payload.noteId &&
          action.clock < operation.clock &&
          action.seq <= (operation.seen?.[operation.deviceId] ?? 0) &&
          (index === 0 ||
            (action.seq === actions[index - 1]!.seq + 1 &&
              action.clock > actions[index - 1]!.clock)) &&
          PAPER_ACTION_TYPES.has(action.type),
      )
    )
      throw new Error('Invalid paper undo targets');
    const objectIds = new Set<string>();
    for (const action of actions) {
      validate(action);
      if (action.type === 'object.create') objectIds.add(action.payload.object.id);
      else {
        objectIds.add(action.payload.objectId);
        if (action.type === 'revision.stroke.split')
          for (const fragment of action.payload.fragments) objectIds.add(fragment.id);
      }
    }
    const undo: PaperUndo = { operation, actions, objectIds };
    undos.set(operation.id, undo);
    register(first, actions[0].id, undo);
    register(last, actions[actions.length - 1].id, undo);
  }
  return { first, last, undos };
}

export function capturePaperUndo(state: NotebookState, undo: PaperUndo): PaperState {
  const note = state.notes.find((candidate) => candidate.id === undo.operation.payload.noteId);
  const objects = note?.pages.flatMap((page) => page.objects) ?? [];
  const segments =
    note?.blocks
      .flatMap((block) => block.segments)
      .filter((segment) => segment.source.objectIds.some((id) => undo.objectIds.has(id))) ?? [];
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const touchedRevisions = new Set(
    objects.filter((object) => undo.objectIds.has(object.id)).map((object) => object.revisionId),
  );
  const corrections = state.corrections.filter(
    (correction) =>
      correction.noteId === note?.id &&
      (segmentIds.has(correction.segmentId) || touchedRevisions.has(correction.id)),
  );
  const revisionIds = new Set([
    ...corrections.map((correction) => correction.id),
    ...(undo.before?.corrections.map((correction) => correction.id) ?? []),
  ]);
  return {
    objects: objects.filter(
      (object) =>
        undo.objectIds.has(object.id) || (object.revisionId && revisionIds.has(object.revisionId)),
    ),
    segments,
    corrections,
  };
}

export function paperUndoTouches(
  undo: PaperUndo,
  current: PaperState,
  event: Operation,
  otherUndo: PaperUndo | undefined,
): boolean {
  const payload = event.payload;
  const objectIds = new Set([
    ...undo.objectIds,
    ...(undo.before?.objects.map((object) => object.id) ?? []),
    ...(undo.after?.objects.map((object) => object.id) ?? []),
  ]);
  const corrections = [...(undo.before?.corrections ?? []), ...current.corrections];
  const touchesObject = (id: unknown) => typeof id === 'string' && objectIds.has(id);
  if (event.type === 'handwriting.learn')
    return (
      corrections.length > 0 || Object.keys(payload.glyph?.sourceVersions ?? {}).some(touchesObject)
    );
  if (payload.noteId !== undo.operation.payload.noteId) return false;
  if (
    [payload.objectId, payload.object?.id, payload.sourceObjectId].some(touchesObject) ||
    (Array.isArray(payload.objectIds) && payload.objectIds.some(touchesObject)) ||
    (otherUndo && [...otherUndo.objectIds].some(touchesObject))
  )
    return true;
  if (corrections.some((correction) => correction.id === payload.revisionId)) return true;
  const segments = [...(undo.before?.segments ?? []), ...current.segments];
  return (
    segments.some((segment) => segment.id === payload.segmentId) ||
    ((segments.length > 0 || corrections.length > 0) &&
      ['block.split', 'block.merge', 'conflict.resolve'].includes(event.type))
  );
}

function byId<T extends { id: string }>(records: T[]) {
  return new Map(records.map((record) => [record.id, record]));
}

export function restorePaperUndo(
  state: NotebookState,
  note: Note,
  undo: PaperUndo,
  current: PaperState,
  matches: (left: unknown, right: unknown) => boolean,
): boolean {
  const { before, after } = undo;
  if (!before || !after || matches(before, after)) return false;
  // A text insert may have been processed automatically after the gesture. Its
  // untouched transcription can be hidden together with the source object.
  const createdObjects = new Set(
    undo.actions
      .filter((action) => action.type === 'object.create')
      .map((action) => action.payload.object.id as string),
  );
  const knownSegments = byId(after.segments);
  const automaticSegments = current.segments.filter((segment) => {
    if (
      knownSegments.has(segment.id) ||
      segment.deleted ||
      segment.source.evidence !== 'deterministic' ||
      segment.source.objectIds.length !== 1 ||
      !createdObjects.has(segment.source.objectIds[0]) ||
      current.corrections.some((correction) => correction.segmentId === segment.id)
    )
      return false;
    const create = state.events.find(
      (operation) =>
        operation.type === 'segment.create' &&
        operation.deviceId === undo.operation.deviceId &&
        operation.payload.segmentId === segment.id &&
        operation.payload.options.deterministic === true &&
        operation.payload.text === segment.text,
    );
    return (
      !!create &&
      segment.chars.every((character) => !character.deleted && character.version === create.id)
    );
  });
  const automaticIds = new Set(automaticSegments.map((segment) => segment.id));
  if (
    !matches(after, {
      ...current,
      segments: current.segments.filter((segment) => !automaticIds.has(segment.id)),
    })
  )
    return false;

  const originalObjects = byId(before.objects),
    editedObjects = byId(after.objects);
  for (const page of note.pages) {
    for (let index = 0; index < page.objects.length; index++) {
      const object = page.objects[index];
      if (!editedObjects.has(object.id)) continue;
      const original = originalObjects.get(object.id);
      if (original) page.objects[index] = structuredClone(original);
      else object.deleted = true; // Other operations may still refer to the object's identity.
    }
  }
  const originalSegments = byId(before.segments);
  for (const block of note.blocks)
    block.segments = block.segments.map((segment) =>
      originalSegments.has(segment.id)
        ? structuredClone(originalSegments.get(segment.id)!)
        : segment,
    );
  for (const segment of automaticSegments) {
    segment.deleted = true;
    for (const character of segment.chars) character.deleted = true;
    segment.text = '';
  }
  const editedCorrections = new Set(after.corrections.map((correction) => correction.id));
  state.corrections = [
    ...state.corrections.filter((correction) => !editedCorrections.has(correction.id)),
    ...structuredClone(before.corrections),
  ];
  return true;
}
