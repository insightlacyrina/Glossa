import test from 'node:test';
import assert from 'node:assert/strict';
import { NotebookEngine } from '../src/domain';
import { atomicAction, blockContentModifiedAt, SyncSessionGuard } from '../src/workspaceSafety';

test('a failing multi-operation transaction restores the entire previous project', () => {
  const engine = new NotebookEngine(undefined, 'writer', 'tablet');
  const id = engine.createNote('preserved');
  const before = structuredClone(engine.project);
  const result = atomicAction(engine, (e) => {
    e.manageNote(id, { title: 'must roll back' });
    e.createFolder('must roll back');
    throw new Error('second step failed');
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.engine.project, before);
  assert.equal(result.engine.getNote(id).title, 'preserved');
  assert.equal(result.engine.state.folders.length, 0);
  const success = atomicAction(result.engine, (e) => e.manageNote(id, { tags: ['kept'] }));
  assert.equal(success.ok, true);
  assert.deepEqual(success.engine.getNote(id).tags, ['kept']);
});

test('delayed responses cannot apply after disconnect or same-project restore', async () => {
  const guard = new SyncSessionGuard();
  const lease = guard.begin('project', 'epoch-1');
  let apply!: () => void;
  const pending = new Promise<boolean>((resolve) => {
    apply = () => {
      try {
        guard.assert(lease, 'project', 'epoch-1');
        resolve(true);
      } catch {
        resolve(false);
      }
    };
  });
  guard.invalidate();
  apply();
  assert.equal(await pending, false);
  const next = guard.begin('project', 'epoch-2');
  assert.equal(guard.current(lease, 'project', 'epoch-2'), false);
  assert.equal(guard.current(next, 'project', 'epoch-2'), true);
  assert.throws(() => guard.assert(next, 'other-project', 'epoch-2'));
});

test('review modification date follows block content and ignores unrelated ink or translation', () => {
  const engine = new NotebookEngine(undefined, 'writer', 'tablet');
  const originalNow = Date.now;
  function at(time: number, action: () => void) {
    Date.now = () => time;
    try {
      action();
    } finally {
      Date.now = originalNow;
    }
  }
  let note = '',
    page = '',
    object = '',
    block = '',
    segment = '';
  at(100, () => {
    note = engine.createNote();
    page = engine.getNote(note).pages[0].id;
  });
  at(200, () => {
    object = engine.addText(note, page, 'abc');
    block = engine.createBlock(note, 'block', [object]);
    segment = engine.recognize(note, block, [object], 'abc', { deterministic: true });
  });
  assert.equal(blockContentModifiedAt(engine.project, engine, note, block), 200);
  at(300, () => {
    engine.addText(note, page, 'unrelated');
  });
  assert.equal(blockContentModifiedAt(engine.project, engine, note, block), 200);
  at(400, () => {
    const obj = engine.getNote(note).pages[0].objects.find((o) => o.id === object)!;
    engine.updateObject(note, object, { bounds: { ...obj.bounds, x: obj.bounds.x + 30 } });
  });
  assert.equal(blockContentModifiedAt(engine.project, engine, note, block), 200);
  at(500, () => engine.editRange(note, segment, 1, 2, 'x'));
  assert.equal(blockContentModifiedAt(engine.project, engine, note, block), 500);
});
