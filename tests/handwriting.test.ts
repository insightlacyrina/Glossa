import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotebookEngine, type Point, type PaperObject } from '../src/domain.ts';
import { captureHandwritingGlyph, composeHandwriting } from '../src/handwriting.ts';

const pen = (x: number, y: number): Point[] => [
  { x, y, pressure: 0.25, tiltX: 18, tiltY: -4, time: 100 },
  { x: x + 10, y: y + 20, pressure: 0.8, tiltX: 21, tiltY: -6, time: 145 },
];
function fixture() {
  const e = new NotebookEngine(undefined, 'tablet', 'tablet');
  const n = e.createNote('正文'),
    p = e.getNote(n).pages[0].id;
  const original = e.addStroke(n, p, [pen(40, 60)[0], { ...pen(40, 60)[1], x: 180 }]);
  const b = e.createBlock(n, '片段', [original]);
  const s = e.recognize(n, b, [original], 'a', { confirmed: true });
  const samplesNote = e.createNote('字形样本'),
    samplesPage = e.getNote(samplesNote).pages[0].id;
  const a = e.addStroke(samplesNote, samplesPage, pen(100, 100), { width: 3, color: '#343434' });
  const b1 = e.addStroke(samplesNote, samplesPage, pen(150, 100), { width: 2 });
  const b2 = e.addStroke(samplesNote, samplesPage, pen(150, 120), { width: 2 });
  const learn = (letter: string) =>
    e.learnHandwritingGlyph(samplesNote, letter === 'a' ? [a] : [b1, b2], letter);
  return { e, n, p, s, original, samplesNote, samplesPage, a, b1, b2, learn };
}
const active = (e: NotebookEngine, n: string, revision?: string) =>
  e
    .getNote(n)
    .pages.flatMap((p) => p.objects)
    .filter((o) => !o.deleted && o.revisionId && (!revision || o.revisionId === revision));

test('B text uses confirmed real glyph vectors at the original location without modifying raw ink', () => {
  const { e, n, s, original, learn } = fixture();
  learn('a');
  learn('b');
  const before = structuredClone(e.getNote(n).pages[0].objects.find((o) => o.id === original));
  const id = e.editSegment(n, s, 'ba')!;
  assert.equal(e.state.corrections.at(-1)?.mode, 'handwriting');
  const generated = active(e, n, id);
  assert.equal(generated.length, 3);
  assert.ok(
    generated.every(
      (o) =>
        o.kind === 'stroke' && o.points?.length === 2 && o.replacesObjectIds?.includes(original),
    ),
  );
  assert.deepEqual(
    generated[0].points!.map((p) => [p.pressure, p.tiltX, p.tiltY, p.time]),
    pen(0, 0).map((p) => [p.pressure, p.tiltX, p.tiltY, p.time]),
  );
  assert.ok(
    generated.every((o) => o.bounds.x >= before!.bounds.x && o.bounds.y >= before!.bounds.y),
  );
  assert.deepEqual(
    e.getNote(n).pages[0].objects.find((o) => o.id === original),
    before,
  );
  const restored = new NotebookEngine(NotebookEngine.importProject(e.exportProject()));
  assert.deepEqual(restored.state, e.state);
});

test('missing characters use an honest printed layer, then retry automatically after explicit glyph confirmation', () => {
  const { e, n, s, learn } = fixture();
  learn('a');
  const id = e.editSegment(n, s, 'ba')!;
  assert.equal(e.state.corrections.at(-1)?.mode, 'printed');
  assert.match(e.state.corrections.at(-1)!.reason, /缺少已确认字形：b/);
  assert.equal(active(e, n, id)[0].text, 'ba');
  learn('b');
  assert.equal(e.state.corrections.at(-1)?.mode, 'handwriting');
  assert.equal(active(e, n, id).length, 3);
  assert.equal(e.getNote(n).blocks[0].segments[0].text, 'ba');
});

test('learning a missing character never overwrites a manually moved printed fallback', () => {
  const { e, n, s, learn } = fixture();
  learn('a');
  const id = e.editSegment(n, s, 'ba')!;
  const layer = active(e, n, id)[0];
  const moved = { ...layer.bounds, x: layer.bounds.x + 50 };
  e.updateObject(n, layer.id, { bounds: moved });
  learn('b');
  assert.equal(e.state.corrections.at(-1)?.mode, 'printed');
  assert.deepEqual(active(e, n, id)[0].bounds, moved);
});

test('glyph snapshots survive deletion and later edits of their original sample source', () => {
  const { e, n, s, samplesNote, a, learn } = fixture();
  learn('a');
  const snapshot = structuredClone(e.state.handwritingGlyphs[0]);
  e.updateObject(samplesNote, a, { points: pen(400, 500) });
  e.deleteObject(samplesNote, a);
  assert.deepEqual(e.state.handwritingGlyphs[0], snapshot);
  const id = e.editRange(n, s, 1, 1, 'a')!;
  assert.equal(e.state.corrections.at(-1)?.mode, 'handwriting');
  assert.equal(active(e, n, id).length, 2);
});

test('a newer B edit hides every stroke in the previous handwritten layer and undo leaks no glyphs', () => {
  const { e, n, s, original, learn } = fixture();
  learn('a');
  learn('b');
  const first = e.editSegment(n, s, 'ba')!,
    second = e.editSegment(n, s, 'ab')!;
  assert.equal(active(e, n, first).length, 0);
  assert.equal(active(e, n, second).length, 3);
  e.undoRevision(second);
  assert.equal(active(e, n, second).length, 0);
  assert.equal(e.getNote(n).pages[0].objects.find((o) => o.id === original)!.deleted, undefined);
  assert.equal(e.getNote(n).blocks[0].segments[0].text, 'ba');
});

test('merging actual handwriting retains stroke editability and removes its dedicated provenance', () => {
  const { e, n, s, original, learn } = fixture();
  learn('a');
  learn('b');
  const id = e.editSegment(n, s, 'ba')!;
  const ids = active(e, n, id).map((o) => o.id);
  assert.throws(() => e.mergeRevision(id));
  e.mergeRevision(id, true);
  const live = e.getNote(n).pages[0].objects.filter((o) => ids.includes(o.id));
  assert.ok(
    live.every(
      (o) => o.kind === 'stroke' && !o.revisionId && !o.replacesObjectIds && o.layerId === 'ink',
    ),
  );
  assert.equal(e.getNote(n).pages[0].objects.find((o) => o.id === original)!.deleted, true);
  assert.throws(() => e.undoRevision(id));
  e.updateObject(n, live[0].id, { points: live[0].points!.map((p) => ({ ...p, x: p.x + 1 })) });
});

test('partial erasure keeps every residual stroke inside the same independently undoable revision', () => {
  const { e, n, s, original, learn } = fixture();
  learn('a');
  learn('b');
  const revision = e.editSegment(n, s, 'ba')!;
  const stroke = active(e, n, revision)[0],
    before = e.project.operations.length;
  const ids = e.splitRevisionStroke(
    n,
    stroke.id,
    [[stroke.points![0]], [stroke.points![1]]],
    stroke.version,
  );
  assert.equal(e.project.operations.length, before + 1);
  assert.equal(ids[0], stroke.id);
  assert.equal(active(e, n, revision).length, 4);
  assert.ok(
    ids.every((id) => e.state.corrections.find((c) => c.id === revision)!.objectIds!.includes(id)),
  );
  assert.ok(
    active(e, n, revision).every(
      (o) => o.revisionId === revision && o.replacesObjectIds?.includes(original),
    ),
  );
  const restored = new NotebookEngine(
    NotebookEngine.importProject(e.exportProject()),
    'restored',
    'tablet',
  );
  restored.undoRevision(revision);
  assert.equal(active(restored, n, revision).length, 0);
  assert.ok(
    ids.every((id) => restored.getNote(n).pages[0].objects.find((o) => o.id === id)!.deleted),
  );
  assert.equal(restored.getNote(n).blocks[0].segments[0].text, 'a');
});

test('partial erasure residuals are all included when handwriting is merged into ordinary ink', () => {
  const { e, n, s, original, learn } = fixture();
  learn('a');
  learn('b');
  const revision = e.editSegment(n, s, 'ba')!,
    stroke = active(e, n, revision)[0];
  const ids = e.splitRevisionStroke(n, stroke.id, [[stroke.points![0]], [stroke.points![1]]]);
  const allIds = active(e, n, revision).map((o) => o.id);
  e.mergeRevision(revision, true);
  const merged = e.getNote(n).pages[0].objects.filter((o) => allIds.includes(o.id));
  assert.equal(merged.length, 4);
  assert.ok(ids.every((id) => merged.some((o) => o.id === id)));
  assert.ok(
    merged.every((o) => !o.deleted && !o.revisionId && !o.replacesObjectIds && o.layerId === 'ink'),
  );
  assert.equal(e.getNote(n).pages[0].objects.find((o) => o.id === original)!.deleted, true);
});

test('partial erasure rejects stale snapshots and malformed residuals atomically', () => {
  const { e, n, s, learn } = fixture();
  learn('a');
  learn('b');
  const revision = e.editSegment(n, s, 'ba')!,
    stroke = active(e, n, revision)[0];
  const before = e.exportProject();
  assert.throws(
    () => e.splitRevisionStroke(n, stroke.id, [[stroke.points![0]]], 'obsolete'),
    /已改变/,
  );
  assert.throws(() => e.splitRevisionStroke(n, stroke.id, [[]]));
  assert.equal(e.exportProject(), before);
  const reader = new NotebookEngine(e.project, 'reader', 'mac');
  assert.throws(() => reader.splitRevisionStroke(n, stroke.id, [[stroke.points![0]]]), /平板/);
  e.splitRevisionStroke(n, stroke.id, [], stroke.version);
  assert.ok(!active(e, n, revision).some((o) => o.id === stroke.id));
  e.undoRevision(revision);
  assert.equal(active(e, n, revision).length, 0);
});

test('concurrent revision erasures converge and preserve a resolvable object conflict', () => {
  const { e, n, s, learn } = fixture();
  learn('a');
  learn('b');
  const revision = e.editSegment(n, s, 'ba')!,
    stroke = active(e, n, revision)[0];
  const one = new NotebookEngine(e.project, 'erase-one', 'tablet');
  const two = new NotebookEngine(e.project, 'erase-two', 'tablet');
  one.splitRevisionStroke(n, stroke.id, [[stroke.points![0]]], stroke.version);
  two.splitRevisionStroke(n, stroke.id, [[stroke.points![1]]], stroke.version);
  one.merge(two.project);
  two.merge(one.project);
  assert.deepEqual(one.state, two.state);
  const conflict = one.state.conflicts.find((c) => c.objectId === stroke.id && !c.resolved)!;
  assert.ok(conflict);
  one.resolveConflict(conflict.id, 'incoming');
  two.merge(one.project);
  assert.deepEqual(one.state, two.state);
  assert.equal(one.state.conflicts.filter((c) => !c.resolved).length, 0);
  one.undoRevision(revision);
  assert.equal(active(one, n, revision).length, 0);
});

test('source changes invalidate pending handwriting without concealing the changed original', () => {
  const { e, n, s, original, learn } = fixture();
  learn('a');
  const id = e.editRange(n, s, 1, 1, 'a')!;
  const source = e.getNote(n).pages[0].objects.find((o) => o.id === original)!;
  e.updateObject(n, original, { points: source.points!.map((p, i) => ({ ...p, y: p.y + i * 4 })) });
  assert.equal(e.getNote(n).blocks[0].segments[0].source.status, 'unmapped');
  assert.equal(active(e, n, id).length, 0);
  assert.throws(() => e.retryHandwritingRevision(id), /来源或落点未确认/);
});

test('sample capture and manual retry respect tablet role and stale previews', () => {
  const { e, n, s, samplesNote, a, learn } = fixture();
  learn('a');
  const id = e.editRange(n, s, 1, 1, 'a')!,
    token = e.handwritingRevisionFingerprint(id);
  const sourceVersion = e.getNote(samplesNote).pages[0].objects.find((o) => o.id === a)!.version;
  e.updateObject(samplesNote, a, { color: '#111' });
  assert.throws(
    () => e.learnHandwritingGlyph(samplesNote, [a], 'a', { [a]: sourceVersion }),
    /已改变/,
  );
  const generated = active(e, n, id)[0];
  assert.throws(() => e.learnHandwritingGlyph(n, [generated.id], 'a'), /原始笔迹/);
  e.updateObject(n, generated.id, { width: 4 });
  assert.throws(() => e.retryHandwritingRevision(id, token), /修订已改变/);
  for (const role of ['phone', 'mac'] as const) {
    const reader = new NotebookEngine(e.project, role, role);
    assert.throws(() => reader.learnHandwritingGlyph(samplesNote, [a], 'a'), /平板/);
    assert.throws(() => reader.retryHandwritingRevision(id), /平板/);
    reader.editRange(n, s, 2, 2, 'a');
    assert.equal(reader.state.corrections.at(-1)?.mode, 'handwriting');
  }
});

test('concurrent B edits converge to exactly the same vector revision and confirmed samples', () => {
  const { e, n, s, learn } = fixture();
  learn('a');
  learn('b');
  const one = new NotebookEngine(e.project, 'one', 'phone'),
    two = new NotebookEngine(e.project, 'two', 'mac');
  one.editRange(n, s, 1, 1, 'a');
  two.editSegment(n, s, 'ba');
  one.merge(two.project);
  two.merge(one.project);
  assert.deepEqual(one.state, two.state);
  assert.ok(active(one, n).every((o) => o.kind === 'stroke'));
  const conflict = one.state.conflicts.find((c) => !c.resolved);
  if (conflict) {
    one.resolveConflict(conflict.id, 'incoming');
    two.merge(one.project);
    assert.deepEqual(one.state, two.state);
  }
});

test('import rejects invented glyph vectors and preserves valid concurrent source translations', () => {
  const { e, samplesNote, a } = fixture();
  const learner = new NotebookEngine(e.project, 'learner', 'tablet');
  const mover = new NotebookEngine(e.project, 'mover', 'tablet');
  learner.learnHandwritingGlyph(samplesNote, [a], 'a');
  mover.updateObject(samplesNote, a, { points: pen(400, 500) });
  learner.merge(mover.project);
  mover.merge(learner.project);
  assert.deepEqual(learner.state, mover.state);
  const forged = structuredClone(learner.project);
  const learn = forged.operations.find((op) => op.type === 'handwriting.learn')!;
  learn.payload.glyph.strokes[0].points[0].x += 0.01;
  assert.throws(() => new NotebookEngine(forged), /快照与声明/);
});

test('invalid, multi-page, oversized, and non-character samples are rejected; overflow stays printed', () => {
  const { e, n, p, samplesNote, a, learn } = fixture();
  assert.throws(() => e.learnHandwritingGlyph(samplesNote, [a], 'ab'));
  assert.throws(() => e.learnHandwritingGlyph(samplesNote, [a], ' '));
  assert.throws(() => e.learnHandwritingGlyph(samplesNote, [a, a], 'a'));
  const other = e.addStroke(n, p, pen(40, 50));
  assert.throws(() => e.learnHandwritingGlyph(samplesNote, [a, other], 'a'));
  learn('a');
  const output = composeHandwriting(
    'a'.repeat(1000),
    { x: 0, y: 0, width: 20, height: 20 },
    e.state.handwritingGlyphs,
  );
  assert.equal(output.strokes.length, 0);
  assert.match(output.reason!, /无法容纳/);
  const bogus = {
    ...e.getNote(samplesNote).pages[0].objects.find((o) => o.id === a)!,
    points: [{ ...pen(0, 0)[0], pressure: NaN }],
  } as PaperObject;
  assert.throws(() => captureHandwritingGlyph('a', samplesNote, [bogus]));
});
