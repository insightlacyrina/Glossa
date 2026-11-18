import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotebookEngine, type Point } from '../src/domain.ts';

const point = (x: number): Point => ({ x, y: 45, pressure: 0.6, tiltX: 4, tiltY: -8, time: x });
function paper() {
  const engine = new NotebookEngine(undefined, 'local-tablet', 'tablet');
  const note = engine.createNote();
  const page = engine.getNote(note).pages[0].id;
  const objects = () => engine.getNote(note).pages[0].objects.filter((object) => !object.deleted);
  const record = (action: () => void) => {
    const count = engine.project.operations.length;
    action();
    return engine.project.operations.slice(count).map((op) => op.id);
  };
  return { engine, note, page, objects, record };
}

test('undo restores an entire split eraser gesture and can then undo the original stroke', () => {
  const { engine, note, page, objects, record } = paper();
  const samples = [point(10), point(40), point(70), point(100)];
  const drawing = record(() => engine.addStroke(note, page, samples, { color: '#1947ab' }));
  const original = structuredClone(objects()[0]);
  const erasing = record(() => {
    engine.updateObject(note, original.id, {
      points: samples.slice(0, 1),
      bounds: { x: 10, y: 45, width: 1, height: 1 },
    });
    engine.addStroke(note, page, samples.slice(2), { color: original.color });
  });
  assert.equal(objects().length, 2);
  const history = structuredClone(engine.project.operations);
  engine.undoPaperAction(note, erasing);
  assert.deepEqual(objects(), [original]);
  engine.undoPaperAction(note, drawing);
  assert.deepEqual(objects(), []);
  assert.deepEqual(engine.project.operations.slice(0, history.length), history);
  assert.equal(engine.project.operations.length, history.length + 2);
  assert.deepEqual(
    new NotebookEngine(NotebookEngine.importProject(engine.exportProject())).state,
    engine.state,
  );
});

test('undo of a paper deletion restores the mapped characters and pending revision layer', () => {
  const { engine, note, page, record } = paper();
  const source = engine.addText(note, page, '文字');
  const block = engine.createBlock(note, '片段', [source]);
  const segment = engine.recognize(note, block, [source], '文字', { deterministic: true });
  engine.editSegment(note, segment, '订正');
  const original = structuredClone(engine.getNote(note));
  const corrections = structuredClone(engine.state.corrections);
  const removal = record(() => engine.deleteObject(note, source));
  assert.equal(engine.state.corrections.length, 0);
  engine.undoPaperAction(note, removal);
  assert.deepEqual(engine.getNote(note).pages, original.pages);
  assert.deepEqual(engine.getNote(note).blocks, original.blocks);
  assert.deepEqual(engine.state.corrections, corrections);
});

test('undo of a newly typed object also hides its unchanged automatic transcription', () => {
  const { engine, note, page, objects, record } = paper();
  let source = '';
  const insertion = record(() => {
    source = engine.addText(note, page, '自动整理');
  });
  const block = engine.createBlock(note, '随记', [source]);
  engine.recognize(note, block, [source], '自动整理', { deterministic: true });
  engine.undoPaperAction(note, insertion);
  assert.deepEqual(objects(), []);
  assert.equal(engine.getNote(note).blocks[0].segments[0].deleted, true);
});

test('merging a concurrent edit preserves the updated object instead of overwriting it with undo', () => {
  const { engine, note, page, objects, record } = paper();
  const drawn = record(() => engine.addStroke(note, page, [point(10)]));
  const object = objects()[0];
  const peer = new NotebookEngine(engine.project, 'peer-tablet', 'tablet');
  peer.updateObject(note, object.id, { color: '#cc2030' });
  engine.undoPaperAction(note, drawn);
  assert.deepEqual(objects(), []);
  const undoId = engine.project.operations.at(-1)!.id;
  engine.merge(peer.project);
  peer.merge(engine.project);
  assert.equal(objects()[0].color, '#cc2030');
  assert.ok(engine.state.conflicts.some((conflict) => conflict.id === undoId));
  assert.deepEqual(peer.state, engine.state);
  assert.throws(() => engine.resolveConflict(undoId, 'incoming'), /保留当前内容/);
});
