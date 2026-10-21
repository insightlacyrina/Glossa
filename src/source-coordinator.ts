import {
  deleteLinkedObject,
  editLinkedPaper,
  openNative,
  renameNative,
  type NativeDocument,
  type NativeLink,
} from './formats';
import type { NotebookEngine } from './domain';

export type SourceRecord = {
  document: NativeDocument;
  link: NativeLink;
  paperObjectId: string;
  noteId: string;
  pageId: string;
  uri?: string;
  sha256?: string;
  ownerDeviceId: string;
  pendingSource?: { document: NativeDocument; sha256?: string; reason: string };
  plannedWrite?: {
    id: string;
    document: NativeDocument;
    link: NativeLink;
    expectedText: string;
    expectedSha256: string;
    paperToken: string;
  };
  pendingNative?: {
    text: string;
    sha256: string;
    baseSha256?: string;
    sourceText: string;
    sourceSha256: string;
    reason: string;
  };
  nativeResolution?: {
    id: string;
    text: string;
    document: NativeDocument;
    expectedSourceText: string;
    expectedSourceSha256: string;
    expectedPendingText: string;
    expectedPendingSha256: string;
  };
};
export type NativePending = {
  pending?: boolean;
  text?: string;
  sha256?: string;
  baseSha256?: string;
};
export type VerifiedPending = {
  kind: 'planned' | 'explicit';
  text: string;
  expectedSourceText: string;
  expectedSourceSha256: string;
};
/** A native SHA alone never authorizes replacing native pending content. Verify its complete known intent. */
export function verifyNativePending(
  record: SourceRecord,
  pending: NativePending,
): VerifiedPending | undefined {
  if (
    !pending.pending ||
    typeof pending.text !== 'string' ||
    !pending.sha256 ||
    !pending.baseSha256
  )
    return;
  const plan = record.plannedWrite;
  if (plan && pending.text === plan.document.text && pending.baseSha256 === plan.expectedSha256)
    return {
      kind: 'planned',
      text: plan.document.text,
      expectedSourceText: plan.expectedText,
      expectedSourceSha256: plan.expectedSha256,
    };
  const resolution = record.nativeResolution;
  if (
    resolution &&
    pending.text === resolution.text &&
    pending.baseSha256 === resolution.expectedSourceSha256
  )
    return {
      kind: 'explicit',
      text: resolution.text,
      expectedSourceText: resolution.expectedSourceText,
      expectedSourceSha256: resolution.expectedSourceSha256,
    };
}
export function previewNativePending(
  record: SourceRecord,
  pending: NativePending,
  sourceText: string,
  sourceSha256: string,
  reason: string,
): SourceRecord {
  if (typeof pending.text !== 'string' || typeof pending.sha256 !== 'string')
    throw new Error('原生待写回内容不完整，未授权覆盖');
  const next = structuredClone(record);
  next.pendingNative = {
    text: pending.text,
    sha256: pending.sha256,
    baseSha256: pending.baseSha256,
    sourceText,
    sourceSha256,
    reason,
  };
  next.link.status = 'conflict';
  return next;
}
export function beginNativeResolution(record: SourceRecord, chosenText: string): SourceRecord {
  if (!record.pendingNative) throw new Error('没有待预览的原生写入冲突');
  const next = structuredClone(record),
    preview = record.pendingNative;
  next.nativeResolution = {
    id: crypto.randomUUID(),
    text: chosenText,
    document: openNative(record.document.name, chosenText, record.document.id),
    expectedSourceText: preview.sourceText,
    expectedSourceSha256: preview.sourceSha256,
    expectedPendingText: preview.text,
    expectedPendingSha256: preview.sha256,
  };
  return next;
}
export function acknowledgeNativeResolution(
  record: SourceRecord,
  actualText: string,
  sha256: string,
): SourceRecord {
  if (!record.nativeResolution || actualText !== record.nativeResolution.text)
    throw new Error('原生决议尚未得到完整源内容确认');
  const next = structuredClone(record);
  next.pendingSource = {
    document: structuredClone(record.nativeResolution.document),
    sha256,
    reason: '原生待写回版本已按你的选择保存，请核对并重新定位纸张对应对象。',
  };
  next.link.status = 'missing';
  delete next.link.unavailableSince;
  delete next.link.writeError;
  delete next.nativeResolution;
  delete next.pendingNative;
  delete next.plannedWrite;
  return next;
}
export type PaperCapture = {
  projectId: string;
  token: string;
  text?: string;
  objectId: string;
  deleted: boolean;
};
export function captureSourcePaper(engine: NotebookEngine, record: SourceRecord): PaperCapture {
  const note = engine.state.notes.find((n) => n.id === record.noteId);
  const object = note?.pages.flatMap((p) => p.objects).find((o) => o.id === record.paperObjectId);
  const segment = note?.blocks
    .flatMap((b) => b.segments)
    .find(
      (s) =>
        !s.deleted &&
        s.source.status === 'exact' &&
        s.source.objectIds.includes(record.paperObjectId),
    );
  const token = JSON.stringify({
    object: object && { id: object.id, version: object.version, deleted: object.deleted },
    segment: segment && {
      id: segment.id,
      chars: segment.chars.map((c) => [c.id, c.version, c.value, c.deleted]),
    },
  });
  return {
    projectId: engine.project.id,
    token,
    text: segment?.text ?? object?.text,
    objectId: record.paperObjectId,
    deleted: !object || !!object.deleted,
  };
}
export function captureStillCurrent(
  engine: NotebookEngine,
  record: SourceRecord,
  captured: PaperCapture,
): boolean {
  const current = captureSourcePaper(engine, record);
  return current.projectId === captured.projectId && current.token === captured.token;
}
export function queueCurrentPaper(record: SourceRecord, capture: PaperCapture): SourceRecord {
  if (
    capture.deleted ||
    capture.text === undefined ||
    record.link.deleted ||
    record.link.mode !== 'linked' ||
    capture.text === record.link.paperContent
  )
    return structuredClone(record);
  return { ...structuredClone(record), link: editLinkedPaper(record.link, capture.text) };
}

function sourceRevision(previous: NativeDocument, next: NativeDocument): NativeDocument {
  return {
    ...next,
    revision: previous.revision + 1,
    history: [
      ...structuredClone(previous.history),
      {
        revision: previous.revision,
        name: previous.name,
        text: previous.text,
        objects: structuredClone(previous.objects),
        at: Date.now(),
        reason: 'external-source-read',
      },
    ],
  };
}
/** Whole-source equality is exact. Changed source requires exact region AND neighboring context. */
export function identifySourceRead(
  record: SourceRecord,
  name: string,
  text: string,
  sha256?: string,
): {
  document?: NativeDocument;
  pendingSource?: SourceRecord['pendingSource'];
  adoptedWrite?: SourceRecord;
} {
  if (record.plannedWrite && text === record.plannedWrite.document.text) {
    const adopted = {
      ...structuredClone(record),
      document: structuredClone(record.plannedWrite.document),
      link: structuredClone(record.plannedWrite.link),
      sha256,
    };
    if (record.link.mode !== 'linked') adopted.link = structuredClone(record.link);
    else if (record.link.deleted && !adopted.link.deleted)
      adopted.link = deleteLinkedObject(adopted.link, 'delete-source').link;
    delete adopted.plannedWrite;
    delete adopted.pendingSource;
    return { document: adopted.document, adoptedWrite: adopted };
  }
  if (text === record.document.text)
    return {
      document:
        name === record.document.name
          ? structuredClone(record.document)
          : renameNative(record.document, name),
    };
  const fresh = sourceRevision(record.document, openNative(name, text, record.document.id));
  const old = record.document.objects.find((o) => o.id === record.link.objectId);
  if (old) {
    const before = record.document.text.slice(Math.max(0, old.start - 64), old.start);
    const after = record.document.text.slice(old.end, old.end + 64);
    const matches = fresh.objects.filter(
      (o) =>
        o.text === old.text &&
        text.slice(Math.max(0, o.start - before.length), o.start) === before &&
        text.slice(o.end, o.end + after.length) === after,
    );
    if (matches.length === 1) {
      matches[0].id = old.id;
      return { document: fresh };
    }
  }
  return {
    pendingSource: {
      document: fresh,
      sha256,
      reason: '源文件已变化，无法证明原对象身份；请核对并重新定位。原快照和待写回修改已保留。',
    },
  };
}
/** Invoked only after the user previews and explicitly selects a source region. */
export function bindSourceObject(record: SourceRecord, candidateId: string): SourceRecord {
  if (!record.pendingSource) throw new Error('没有待定位的源文件');
  const next = structuredClone(record),
    pending = next.pendingSource!;
  const object = pending.document.objects.find((o) => o.id === candidateId);
  if (!object) throw new Error('候选源对象不存在');
  object.id = next.link.objectId;
  next.document = pending.document;
  next.sha256 = pending.sha256;
  next.link.status = next.link.queued.length ? 'pending' : 'clean';
  delete next.pendingSource;
  delete next.plannedWrite;
  return next;
}
/** Identity review pauses writes, never source-access observations or the confirmed freeze deadline. */
export function refreshPendingSourceRead(
  record: SourceRecord,
  name: string,
  text: string,
  sha256?: string,
): SourceRecord {
  if (!record.pendingSource) throw new Error('源对象不在待定位状态');
  const next = structuredClone(record),
    pending = next.pendingSource!;
  if (pending.document.text !== text)
    pending.document = sourceRevision(pending.document, openNative(name, text, record.document.id));
  else if (pending.document.name !== name) pending.document = renameNative(pending.document, name);
  pending.sha256 = sha256;
  next.link.status = 'missing';
  delete next.link.unavailableSince;
  delete next.link.writeError;
  return next;
}
/** An explicit preview choice rebases against the observed source, never an inferred source. */
export function chooseSourceConflict(record: SourceRecord, text: string): SourceRecord {
  if (!record.link.conflict) throw new Error('没有待决议的源冲突');
  const source = record.document.objects.find((o) => o.id === record.link.objectId);
  if (!source || source.text !== record.link.conflict.source)
    throw new Error('源冲突预览已过期，请重新定位');
  const next = structuredClone(record);
  next.link.baseContent = source.text;
  next.link.paperContent = source.text;
  next.link.sourceSnapshot = structuredClone(record.document);
  next.link.queued = [];
  next.link.deleted = false;
  next.link.status = 'clean';
  delete next.link.conflict;
  next.link = editLinkedPaper(next.link, text);
  delete next.plannedWrite;
  return next;
}
/** A delete conflict is resolved as a delete operation, never as an empty text edit. */
export function confirmSourceDeletion(record: SourceRecord): SourceRecord {
  if (
    !record.link.deleted ||
    !record.link.queued.some((op) => op.kind === 'delete-source') ||
    !record.link.conflict
  )
    throw new Error('没有待决议的源删除');
  const source = record.document.objects.find((o) => o.id === record.link.objectId);
  if (!source || source.text !== record.link.conflict.source) throw new Error('源删除预览已过期');
  const next = structuredClone(record);
  next.link.baseContent = source.text;
  next.link.paperContent = source.text;
  next.link.sourceSnapshot = structuredClone(record.document);
  next.link.queued = [];
  next.link.deleted = false;
  next.link.status = 'clean';
  delete next.link.conflict;
  next.link = deleteLinkedObject(next.link, 'delete-source').link;
  delete next.plannedWrite;
  return next;
}
