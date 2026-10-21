import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openNative,
  openNativeBytes,
  serializeNative,
  serializeNativeBytes,
  editNative,
  validateNative,
  renameNative,
  createNativeLink,
  editLinkedPaper,
  reconcileNativeLink,
  mergeNativeText,
  markSourceUnavailable,
  relinkNativeSource,
  resolveNativeConflict,
  deleteLinkedObject,
  commitNativeWriteback,
} from '../src/formats';

test('Markdown real UTF-8 read → two native-region edits → write → reopen preserves all other bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quiet-paper-md-'));
  try {
    const input =
      '\uFEFF# 实验手记\r\n\r\n<!-- keep: untouched -->\r\n\r\n$$E = mc^2$$\r\n\r\n```ts\r\nconst x = "你好";\r\n```\r\n';
    const path = join(dir, '实验.md');
    await writeFile(path, input, 'utf8');
    const doc = openNativeBytes('实验.md', await readFile(path));
    assert.deepEqual(serializeNativeBytes(doc), new Uint8Array(await readFile(path)));
    const title = doc.objects[0],
      formula = doc.objects.find((o) => o.kind === 'formula')!;
    const changed = editNative(
      doc,
      [
        { objectId: title.id, replacement: '\uFEFF# 实验修订\r\n' },
        { objectId: formula.id, replacement: '$$E = mc^3$$\r\n' },
      ],
      10,
    );
    await writeFile(path, serializeNativeBytes(changed));
    const reopened = openNativeBytes('实验.md', await readFile(path));
    assert.equal(reopened.text, input.replace('实验手记', '实验修订').replace('mc^2', 'mc^3'));
    assert.equal(changed.objects.find((o) => o.id === formula.id)!.text, '$$E = mc^3$$\r\n');
    assert.equal(changed.history.length, 1);
    assert.equal(changed.history[0].text, input);
    validateNative(changed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('LaTeX real file round trip changes one equation and preserves comments/macros/document structure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quiet-paper-tex-'));
  try {
    const original =
      '\\documentclass{article}\n% untouched comment 中文\n\\newcommand{\\vect}[1]{\\mathbf{#1}}\n\\begin{document}\n\\section{力学}\n\\begin{equation}\nF = ma\n\\end{equation}\n\\end{document}\n';
    const path = join(dir, 'mechanics.tex');
    await writeFile(path, original);
    const doc = openNativeBytes('mechanics.tex', await readFile(path)),
      equation = doc.objects.find((o) => o.kind === 'formula')!;
    const changed = editNative(
      doc,
      [{ objectId: equation.id, replacement: equation.text.replace('F = ma', 'F = m a + b') }],
      20,
    );
    await writeFile(path, serializeNativeBytes(changed));
    const reopened = openNativeBytes('mechanics.tex', await readFile(path));
    assert.equal(reopened.text, original.replace('F = ma', 'F = m a + b'));
    assert.equal(reopened.objects.filter((o) => o.kind === 'formula').length, 1);
    assert.equal(doc.text, original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unsupported native formats and malformed UTF-8 fail explicitly without converting to images', () => {
  assert.throws(() => openNative('deck.key', 'bytes'), /尚未验证/);
  assert.throws(() => openNativeBytes('note.md', new Uint8Array([0xff, 0xfe])));
});

test('native range tampering is rejected rather than guessing object correspondence', () => {
  const doc = openNative('note.md', '# Title\n\ncontent\n');
  doc.objects[0].start = 1;
  assert.throws(() => serializeNative(doc), /不一致/);
});

test('nonoverlapping symbol revisions in the same formula merge from both writers', () => {
  assert.equal(mergeNativeText('a+b=c', 'x+b=c', 'a+y=c').text, 'x+y=c');
  assert.equal(mergeNativeText('α+β=γ', 'α+θ=γ', 'α+β=δ').text, 'α+θ=δ');
  assert.equal(mergeNativeText('🙂+β=γ', '🙂+θ=γ', '🙃+β=γ').text, '🙃+θ=γ');
  assert.equal(mergeNativeText('123456789', '1A3456B89', '123C5678D').text, '1A3C56B8D');
});

test('true symbol contention produces full conflict preview without overwriting either side', () => {
  const result = mergeNativeText('x+y', 'a+y', 'b+y');
  assert.equal(result.text, undefined);
  assert.equal(result.conflict!.base, 'x+y');
  assert.equal(result.conflict!.paper, 'a+y');
  assert.equal(result.conflict!.source, 'b+y');
  assert.equal(mergeNativeText('abc', 'aXbc', 'aYbc').conflict?.reason.includes('相同'), true);
  assert.equal(mergeNativeText('abc', 'aXbc', 'aXbc').text, 'aXbc');
});

test('paper/source dynamic writeback preserves independent modifications and native history', () => {
  const doc = openNative('physics.md', '$$a+b=c$$\n');
  const object = doc.objects[0];
  const link = editLinkedPaper(createNativeLink(doc, object.id, { now: 1 }), '$$x+b=c$$\n', 2);
  const external = editNative(doc, [{ objectId: object.id, replacement: '$$a+y=c$$\n' }], 3);
  const synced = reconcileNativeLink(link, external, 4);
  assert.equal(synced.link.paperContent, '$$x+y=c$$\n');
  assert.equal(serializeNative(synced.document), '$$x+y=c$$\n');
  assert.equal(synced.link.status, 'clean');
  assert.equal(synced.link.queued.length, 0);
  assert.equal(synced.document.history.length, 2);
  assert.equal(link.queued.length, 1);
});

test('a source-only change updates linked paper and filename without a writeback operation', () => {
  const doc = openNative('old.md', 'original\n');
  const link = createNativeLink(doc, doc.objects[0].id, { now: 1 });
  const external = renameNative(
    editNative(doc, [{ objectId: doc.objects[0].id, replacement: 'updated\n' }], 2),
    'new.md',
    3,
  );
  const result = reconcileNativeLink(link, external, 4);
  assert.equal(result.link.paperContent, 'updated\n');
  assert.equal(result.link.sourceName, 'new.md');
  assert.equal(result.document.revision, external.revision);
});

test('true source conflict waits for explicit preview choice and rejects stale decisions', () => {
  const doc = openNative('note.md', 'abc\n'),
    object = doc.objects[0];
  const local = editLinkedPaper(createNativeLink(doc, object.id), 'axc\n');
  const external = editNative(doc, [{ objectId: object.id, replacement: 'ayc\n' }]);
  const result = reconcileNativeLink(local, external);
  assert.equal(result.link.status, 'conflict');
  assert.equal(result.document.text, 'ayc\n');
  const resolved = resolveNativeConflict(result.link, result.document, 'azc\n');
  assert.equal(resolved.link.paperContent, 'azc\n');
  assert.equal(resolved.document.text, 'azc\n');
  const changedAgain = editNative(external, [{ objectId: object.id, replacement: 'aqc\n' }]);
  assert.throws(() => resolveNativeConflict(result.link, changedAgain, 'azc\n'), /再次改变/);
});

test('source outages queue edits then freeze a recoverable independent copy after configured timeout', () => {
  const doc = openNative('note.md', 'saved source\n');
  const original = createNativeLink(doc, doc.objects[0].id, { offlineTimeoutMs: 100, now: 1 });
  const failed = markSourceUnavailable(original, 10);
  const edited = editLinkedPaper(failed, 'offline edit\n', 50);
  assert.equal(edited.unavailableSince, 10);
  assert.equal(markSourceUnavailable(edited, 109).mode, 'linked');
  const frozen = markSourceUnavailable(edited, 110);
  assert.equal(frozen.mode, 'frozen');
  assert.equal(frozen.paperContent, 'offline edit\n');
  assert.equal(frozen.sourceSnapshot.text, 'saved source\n');
  assert.equal(frozen.queued.length, 1);
  const later = reconcileNativeLink(frozen, doc, 200);
  assert.equal(later.document.text, 'saved source\n');
  assert.equal(later.link.mode, 'frozen');
});

test('offline edits write back on source recovery before expiry', () => {
  const doc = openNative('note.md', 'old\n');
  const link = editLinkedPaper(
    markSourceUnavailable(
      createNativeLink(doc, doc.objects[0].id, { now: 1, offlineTimeoutMs: 1000 }),
      10,
    ),
    'new\n',
    20,
  );
  const recovered = reconcileNativeLink(link, doc, 30);
  assert.equal(recovered.document.text, 'new\n');
  assert.equal(recovered.link.unavailableSince, undefined);
});

test('move/rename relink requires exact full source and source-span identity; filename alone cannot bind', () => {
  const doc = openNative('old.md', '# Heading\n\nBody\n');
  const link = createNativeLink(doc, doc.objects[1].id);
  const candidate = openNative('renamed.md', doc.text);
  const relocated = relinkNativeSource(link, candidate);
  assert.equal(relocated.matched, true);
  assert.equal(relocated.link.sourceId, candidate.id);
  assert.equal(relocated.link.objectId, candidate.objects[1].id);
  const wrong = openNative('old.md', '# Heading\n\nDifferent\n');
  assert.equal(relinkNativeSource(link, wrong).matched, false);
  assert.equal(relinkNativeSource(link, wrong).link.sourceSnapshot.text, doc.text);
});

test('a missing source object never erases its paper preview or source snapshot', () => {
  const doc = openNative('note.md', 'retain me\n');
  const link = createNativeLink(doc, doc.objects[0].id);
  const missing = structuredClone(doc);
  missing.objects = [];
  const result = reconcileNativeLink(link, missing);
  assert.equal(result.link.status, 'missing');
  assert.equal(result.link.paperContent, 'retain me\n');
  assert.equal(result.link.sourceSnapshot.text, 'retain me\n');
});

test('explicit detach never changes source; explicit delete-source removes only the selected region', () => {
  const doc = openNative('note.md', 'keep\n\ndelete\n');
  const link = createNativeLink(doc, doc.objects[1].id);
  assert.equal(deleteLinkedObject(link, 'detach', doc).document!.text, doc.text);
  const deletion = deleteLinkedObject(link, 'delete-source', doc);
  assert.equal(deletion.document!.text, 'keep\n\n');
  assert.equal(deletion.link.mode, 'detached');
  assert.equal(deletion.document!.history[0].text, doc.text);
  assert.equal(doc.text, 'keep\n\ndelete\n');
});

test('queued source deletion must preview changed source content before it can delete anything', () => {
  const doc = openNative('note.md', 'base\n');
  const object = doc.objects[0];
  const deletion = deleteLinkedObject(createNativeLink(doc, object.id), 'delete-source');
  assert.equal(deletion.link.status, 'pending');
  assert.equal(deletion.document, undefined);
  const changed = editNative(doc, [{ objectId: object.id, replacement: 'source changed\n' }]);
  const conflict = reconcileNativeLink(deletion.link, changed);
  assert.equal(conflict.link.status, 'conflict');
  assert.equal(conflict.document.text, 'source changed\n');
  assert.equal(conflict.conflict!.paper, '');
});

test('repeated-symbol identity uncertainty is retained for proofreading instead of inventing precise correspondence', () => {
  const result = mergeNativeText('aaa', 'aa', 'baa');
  assert.equal(result.conflict?.kind, 'unverified-correspondence');
  assert.equal(result.conflict?.paper, 'aa');
  assert.equal(result.conflict?.source, 'baa');
  assert.equal(mergeNativeText('aaa', 'aa', 'aa').text, 'aa');
});

test('real external write failure retains every queued edit and original recovery snapshot', async () => {
  const doc = openNative('note.md', 'source\n');
  const link = editLinkedPaper(createNativeLink(doc, doc.objects[0].id), 'pending\n');
  let attempt = 0;
  const failed = await commitNativeWriteback(link, doc, async (next, expected) => {
    attempt++;
    assert.equal(next.text, 'pending\n');
    assert.equal(expected.text, doc.text);
    throw new Error('source is read-only');
  });
  assert.equal(attempt, 1);
  assert.equal(failed.writeError, 'source is read-only');
  assert.equal(failed.link.status, 'pending');
  assert.deepEqual(failed.link.queued, link.queued);
  assert.equal(failed.link.paperContent, 'pending\n');
  assert.equal(failed.link.sourceSnapshot.text, doc.text);
  assert.equal(failed.document.text, doc.text);
  const success = await commitNativeWriteback(failed.link, doc, async (_next, expected) => {
    assert.equal(expected.fingerprint, doc.fingerprint);
  });
  assert.equal(success.link.status, 'clean');
  assert.equal(success.link.queued.length, 0);
});
