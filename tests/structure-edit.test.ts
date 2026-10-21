import test from 'node:test';
import assert from 'node:assert/strict';
import { codepointOffset, inputRange, replacedValue } from '../src/structure-edit.ts';
import { NotebookEngine } from '../src/domain.ts';

test('DOM UTF16 selection resolves exact repeated symbol identity across surrogate pairs', () => {
  const before = '😀xx+x';
  assert.equal(codepointOffset(before, 2), 1);
  const range = inputRange(before, 3, 4, 'insertText', 'y');
  assert.deepEqual(range, { start: 2, end: 3, replacement: 'y' });
  assert.equal(replacedValue(before, range!), '😀xy+x');
});

test('backspace and selected cuts keep the concrete symbol range', () => {
  assert.deepEqual(inputRange('xxx', 2, 2, 'deleteContentBackward', null), {
    start: 1,
    end: 2,
    replacement: '',
  });
  assert.deepEqual(inputRange('xxx', 0, 1, 'deleteByCut', null), {
    start: 0,
    end: 1,
    replacement: '',
  });
  assert.equal(inputRange('word', 4, 4, 'insertReplacementText', 'other'), null);
});

test('editor session branch merges disjoint edits on repeated symbols without whole string guesses', () => {
  const latest = new NotebookEngine(undefined, 'tablet');
  const noteId = latest.createNote('字符范围');
  const pageId = latest.getNote(noteId).pages[0].id;
  const objectId = latest.addText(noteId, pageId, '😀xx+x');
  const blockId = latest.createBlock(noteId, '公式', [objectId]);
  const segmentId = latest.recognize(noteId, blockId, [objectId], '😀xx+x', {
    deterministic: true,
    kind: 'formula',
  });
  const branch = new NotebookEngine(structuredClone(latest.project), 'phone-editor', 'phone');
  const middleX = inputRange('😀xx+x', 3, 4, 'insertText', 'y')!;
  branch.editRange(noteId, segmentId, middleX.start, middleX.end, middleX.replacement);
  latest.editRange(noteId, segmentId, 4, 5, 'z');
  latest.merge(branch.project);
  assert.equal(latest.getNote(noteId).blocks[0].segments[0].text, '😀xy+z');
  assert.equal(latest.state.conflicts.length, 0);
});

test('editor branch surfaces a true conflict on the same repeated symbol', () => {
  const latest = new NotebookEngine(undefined, 'tablet');
  const noteId = latest.createNote('并行');
  const objectId = latest.addText(noteId, latest.getNote(noteId).pages[0].id, 'xxx');
  const blockId = latest.createBlock(noteId, '重复符号', [objectId]);
  const segmentId = latest.recognize(noteId, blockId, [objectId], 'xxx', { deterministic: true });
  const branch = new NotebookEngine(structuredClone(latest.project), 'mac-editor', 'mac');
  branch.editRange(noteId, segmentId, 1, 2, 'a');
  latest.editRange(noteId, segmentId, 1, 2, 'b');
  latest.merge(branch.project);
  assert.equal(latest.state.conflicts.filter((conflict) => !conflict.resolved).length, 1);
});
