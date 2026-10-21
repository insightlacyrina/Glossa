import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotebookEngine } from '../src/domain';
import {
  createNativeLink,
  deleteLinkedObject,
  editLinkedPaper,
  editNative,
  openNative,
  reconcileNativeLink,
} from '../src/formats';
import {
  acknowledgeNativeResolution,
  beginNativeResolution,
  bindSourceObject,
  captureSourcePaper,
  captureStillCurrent,
  chooseSourceConflict,
  confirmSourceDeletion,
  identifySourceRead,
  previewNativePending,
  queueCurrentPaper,
  refreshPendingSourceRead,
  verifyNativePending,
  type SourceRecord,
} from '../src/source-coordinator';

function fixture(text = 'a+b=c\n') {
  const engine = new NotebookEngine(undefined, 'source-tests', 'tablet'),
    noteId = engine.createNote('Native'),
    pageId = engine.getNote(noteId).pages[0].id;
  const document = openNative('source.md', text),
    object = document.objects[0];
  const paperObjectId = engine.addText(noteId, pageId, object.text);
  const block = engine.createBlock(noteId, 'Native content', [paperObjectId]);
  const segmentId = engine.recognize(noteId, block, [paperObjectId], object.text, {
    deterministic: true,
  });
  const record: SourceRecord = {
    document,
    link: createNativeLink(document, object.id),
    paperObjectId,
    noteId,
    pageId,
    uri: 'content://source',
    sha256: 'old-sha',
    ownerDeviceId: 'install',
  };
  return { engine, record, segmentId };
}

test('unchanged native bytes reuse every exact source identity', () => {
  const { record } = fixture();
  const read = identifySourceRead(record, 'source.md', record.document.text, 'same-sha');
  assert.deepEqual(read.document, record.document);
  assert.equal(read.pendingSource, undefined);
});

test('a provider rename with identical native contents updates the name while preserving object identities', () => {
  const { record } = fixture();
  const read = identifySourceRead(record, 'renamed.md', record.document.text, 'same-sha');
  assert.equal(read.document!.name, 'renamed.md');
  assert.equal(read.document!.objects[0].id, record.link.objectId);
  assert.equal(read.document!.history.at(-1)!.name, 'source.md');
});

test('changed content at the exact old offset never inherits the original object ID by position', () => {
  const { record } = fixture('original\n');
  const changed = identifySourceRead(record, 'source.md', 'attacker\n', 'new-sha');
  assert.equal(changed.document, undefined);
  assert(changed.pendingSource);
  assert.notEqual(changed.pendingSource.document.objects[0].id, record.link.objectId);
  assert.equal(record.document.text, 'original\n');
  assert.equal(record.link.baseContent, 'original\n');
});

test('an unchanged unique region and exact nearby context can survive an unrelated distant source change', () => {
  const { record } = fixture(
    'target\n\n' + 'long unchanged context '.repeat(10) + '\n\nold tail\n',
  );
  const read = identifySourceRead(
    record,
    'source.md',
    record.document.text.replace('old tail', 'new tail'),
    'new-sha',
  );
  assert(read.document);
  assert.equal(read.document.objects[0].id, record.link.objectId);
  assert.equal(read.document.history.at(-1)!.text, record.document.text);
});

test('manual source selection is explicit, keeps the paper edit, and preserves the old source snapshot', () => {
  const { record } = fixture('base\n');
  record.link = editLinkedPaper(record.link, 'paper\n');
  const changed = identifySourceRead(record, 'source.md', 'source\n', 'new-sha');
  const pending = { ...record, pendingSource: changed.pendingSource };
  const chosen = bindSourceObject(pending, pending.pendingSource!.document.objects[0].id);
  assert.equal(chosen.document.objects[0].id, record.link.objectId);
  assert.equal(chosen.link.paperContent, 'paper\n');
  assert.equal(chosen.link.sourceSnapshot.text, 'base\n');
  const result = reconcileNativeLink(chosen.link, chosen.document);
  assert.equal(result.conflict!.paper, 'paper\n');
  assert.equal(result.conflict!.source, 'source\n');
});

test('unresolved source identity can observe availability and new candidates without rebinding or dropping pending edits', () => {
  const { record } = fixture('base\n');
  record.link = editLinkedPaper(record.link, 'paper\n');
  record.pendingSource = identifySourceRead(
    record,
    'source.md',
    'changed\n',
    'first',
  ).pendingSource;
  record.link.unavailableSince = 100;
  record.link.status = 'unavailable';
  const next = refreshPendingSourceRead(record, 'source.md', 'changed again\n', 'second');
  assert.equal(next.link.objectId, record.link.objectId);
  assert.equal(next.link.baseContent, 'base\n');
  assert.equal(next.link.paperContent, 'paper\n');
  assert.equal(next.link.queued.length, 1);
  assert.equal(next.link.unavailableSince, undefined);
  assert.equal(next.link.status, 'missing');
  assert.equal(next.pendingSource!.document.text, 'changed again\n');
  assert.notEqual(next.pendingSource!.document.objects[0].id, next.link.objectId);
  assert.equal(next.pendingSource!.document.history.at(-1)!.text, 'changed\n');
});

test('capture guards detect B revisions even when a later edit restores the same visible string', () => {
  const { engine, record, segmentId } = fixture();
  const captured = captureSourcePaper(engine, record);
  engine.editSegment(record.noteId, segmentId, 'x+b=c\n');
  engine.editSegment(record.noteId, segmentId, 'a+b=c\n');
  assert.equal(captureSourcePaper(engine, record).text, captured.text);
  assert.equal(captureStillCurrent(engine, record, captured), false);
});

test('unrelated later handwriting does not invalidate a source object capture', () => {
  const { engine, record } = fixture();
  const captured = captureSourcePaper(engine, record);
  engine.addStroke(record.noteId, record.pageId, [
    { x: 1, y: 2, pressure: 0.7, tiltX: 1, tiltY: 2, time: 3 },
  ]);
  assert.equal(captureStillCurrent(engine, record, captured), true);
});

test('a durable pending write can be acknowledged after a crash only by exact full target contents', () => {
  const { record } = fixture('base\n');
  record.link = editLinkedPaper(record.link, 'written\n');
  const plan = reconcileNativeLink(record.link, record.document);
  record.plannedWrite = {
    id: 'pending-write',
    document: plan.document,
    link: plan.link,
    expectedText: record.document.text,
    expectedSha256: 'old-sha',
    paperToken: 'captured',
  };
  const observed = identifySourceRead(record, record.document.name, 'written\n', 'written-sha');
  assert(observed.adoptedWrite);
  assert.equal(observed.adoptedWrite.document.objects[0].id, record.link.objectId);
  assert.equal(observed.adoptedWrite.plannedWrite, undefined);
  assert.equal(observed.adoptedWrite.link.queued.length, 0);
  const altered = identifySourceRead(record, record.document.name, 'other version\n', 'other-sha');
  assert.equal(altered.adoptedWrite, undefined);
  assert(altered.pendingSource);
});

test('a post-write newer B revision remains queued after recovery acknowledges the earlier write', () => {
  const { engine, record, segmentId } = fixture('base\n');
  record.link = editLinkedPaper(record.link, 'first\n');
  const plan = reconcileNativeLink(record.link, record.document);
  record.plannedWrite = {
    id: 'pending-write',
    document: plan.document,
    link: plan.link,
    expectedText: record.document.text,
    expectedSha256: 'old-sha',
    paperToken: 'captured',
  };
  engine.editSegment(record.noteId, segmentId, 'newer\n');
  const adopted = identifySourceRead(
    record,
    record.document.name,
    'first\n',
    'written-sha',
  ).adoptedWrite!;
  const queued = queueCurrentPaper(adopted, captureSourcePaper(engine, record));
  assert.equal(queued.link.baseContent, 'first\n');
  assert.equal(queued.link.paperContent, 'newer\n');
  assert.equal(queued.link.queued.at(-1)!.text, 'newer\n');
});

test('explicit content conflict choice rebases against the verified source and queues the chosen text', () => {
  const { record } = fixture('base\n');
  record.link = editLinkedPaper(record.link, 'paper\n');
  const source = editNative(record.document, [
    { objectId: record.link.objectId, replacement: 'source\n' },
  ]);
  const conflict = reconcileNativeLink(record.link, source);
  record.document = source;
  record.link = conflict.link;
  const chosen = chooseSourceConflict(record, 'manual\n');
  assert.equal(chosen.link.baseContent, 'source\n');
  assert.equal(chosen.link.paperContent, 'manual\n');
  assert.equal(chosen.link.status, 'pending');
  assert.equal(chosen.link.conflict, undefined);
  assert.equal(chosen.document.text, 'source\n');
});

test('delete conflict confirmation retains a real delete-source operation instead of empty text editing', () => {
  const { record } = fixture('base\n');
  record.link = deleteLinkedObject(record.link, 'delete-source').link;
  const source = editNative(record.document, [
    { objectId: record.link.objectId, replacement: 'new source\n' },
  ]);
  const conflict = reconcileNativeLink(record.link, source);
  record.document = source;
  record.link = conflict.link;
  const chosen = confirmSourceDeletion(record);
  assert.equal(chosen.link.deleted, true);
  assert.equal(chosen.link.baseContent, 'new source\n');
  assert.equal(chosen.link.queued.at(-1)!.kind, 'delete-source');
  const result = reconcileNativeLink(chosen.link, source);
  assert.equal(result.document.objects.length, 0);
  assert.equal(result.document.text, '');
});

test('native pending verification requires both the complete known target and original base, never its SHA alone', () => {
  const { record } = fixture('base\n');
  record.link = editLinkedPaper(record.link, 'known target\n');
  const plan = reconcileNativeLink(record.link, record.document);
  record.plannedWrite = {
    id: 'own-intent',
    document: plan.document,
    link: plan.link,
    expectedText: record.document.text,
    expectedSha256: 'base-sha',
    paperToken: 'old-capture',
  };
  assert.equal(
    verifyNativePending(record, {
      pending: true,
      text: 'known target\n',
      sha256: 'native-target-sha',
      baseSha256: 'base-sha',
    })?.kind,
    'planned',
  );
  assert.equal(
    verifyNativePending(record, {
      pending: true,
      text: 'unknown text\n',
      sha256: 'native-target-sha',
      baseSha256: 'base-sha',
    }),
    undefined,
  );
  assert.equal(
    verifyNativePending(record, {
      pending: true,
      text: 'known target\n',
      sha256: 'native-target-sha',
      baseSha256: 'other-base',
    }),
    undefined,
  );
  assert.equal(
    verifyNativePending(record, {
      pending: false,
      text: 'known target\n',
      sha256: 'native-target-sha',
      baseSha256: 'base-sha',
    }),
    undefined,
  );
});

test('unknown native pending preview preserves the source, B queue, and prior write plan until an explicit whole-document choice', () => {
  const { record } = fixture('base\n');
  record.link = editLinkedPaper(record.link, 'latest B\n');
  const blocked = previewNativePending(
    record,
    { pending: true, text: 'unknown pending\n', sha256: 'pending-sha', baseSha256: 'base-sha' },
    'remote source\n',
    'remote-sha',
    'unknown origin',
  );
  assert.equal(blocked.document.text, 'base\n');
  assert.equal(blocked.link.paperContent, 'latest B\n');
  assert.deepEqual(blocked.link.queued, record.link.queued);
  assert.equal(blocked.pendingNative!.text, 'unknown pending\n');
  const intent = beginNativeResolution(blocked, 'chosen whole file\n');
  assert.equal(intent.nativeResolution!.expectedPendingSha256, 'pending-sha');
  assert.equal(intent.nativeResolution!.expectedSourceSha256, 'remote-sha');
  assert.throws(
    () => acknowledgeNativeResolution(intent, 'not the chosen file\n', 'other-sha'),
    /完整源内容/,
  );
  const confirmed = acknowledgeNativeResolution(intent, 'chosen whole file\n', 'chosen-sha');
  assert.equal(confirmed.pendingNative, undefined);
  assert.equal(confirmed.nativeResolution, undefined);
  assert.equal(confirmed.pendingSource!.document.text, 'chosen whole file\n');
  assert.equal(confirmed.link.paperContent, 'latest B\n');
  assert.equal(confirmed.link.queued.length, 1);
  assert.equal(confirmed.document.text, 'base\n');
});

test('a failed explicitly chosen native resolution is retryable only for its known full target and authorized base', () => {
  const { record } = fixture();
  const blocked = previewNativePending(
    record,
    { pending: true, text: 'unknown\n', sha256: 'old-pending' },
    'current source\n',
    'current-sha',
    'preview',
  );
  const intent = beginNativeResolution(blocked, 'manual full source\n');
  assert.equal(
    verifyNativePending(intent, {
      pending: true,
      text: 'manual full source\n',
      sha256: 'chosen-sha',
      baseSha256: 'current-sha',
    })?.kind,
    'explicit',
  );
  assert.equal(
    verifyNativePending(intent, {
      pending: true,
      text: 'unknown\n',
      sha256: 'old-pending',
      baseSha256: 'current-sha',
    }),
    undefined,
  );
});
