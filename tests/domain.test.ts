import test from 'node:test';
import assert from 'node:assert/strict';
import { NotebookEngine, type Point } from '../src/domain.ts';
const points: Point[] = [
  { x: 10, y: 20, pressure: 0.3, tiltX: 18, tiltY: -5, time: 1 },
  { x: 30, y: 40, pressure: 0.8, tiltX: 20, tiltY: -6, time: 3 },
];
function seed(text = 'x+y=7', kind: 'formula' | 'text' = 'formula') {
  const e = new NotebookEngine(undefined, 'tablet', 'tablet'),
    n = e.createNote('手写', { size: 'B5', template: 'grid' }),
    p = e.getNote(n).pages[0].id,
    o = e.addStroke(n, p, points),
    b = e.createBlock(n, '方程', [o]),
    s = e.recognize(n, b, [o], text, {
      kind,
      confirmed: true,
      confidence: 1,
      charMap: Array.from(text).map((_, index) => ({ index, objectIds: [o], glyphIds: [o] })),
    });
  return { e, n, p, o, b, s };
}
function segment(e: NotebookEngine, n: string, s: string) {
  return e
    .getNote(n)
    .blocks.flatMap((b) => b.segments)
    .find((x) => x.id === s)!;
}
test('paper is fixed and stores actual editable pressure and tilt', () => {
  const { e, n, p, o } = seed();
  const page = e.getNote(n).pages.find((x) => x.id === p)!;
  assert.equal(page.width, 704);
  assert.equal(page.height, 1000);
  assert.deepEqual(page.objects.find((x) => x.id === o)!.points, points);
  assert.equal(e.getNote(n).pages.length, 1);
});
test('unverified OCR never becomes an exact mapping even with high confidence', () => {
  const { e, n, b, o } = seed();
  const s = e.recognize(n, b, [o], 'candidate', { confidence: 0.9999 });
  assert.equal(segment(e, n, s).source.status, 'unmapped');
  assert.equal(e.findCorrespondence(n, s).status, 'unmapped');
  assert.equal(e.validateMappings().find((x) => x.segmentId === s)!.valid, false);
});
test('verified character identities and source glyphs survive edits and round trips', () => {
  const { e, n, s, o } = seed();
  const ids = segment(e, n, s).chars.map((x) => x.id);
  assert.equal(e.findCorrespondence(n, o).charIds.length, 5);
  e.editSegment(n, s, 'a+y=7');
  assert.deepEqual(
    segment(e, n, s).chars.map((x) => x.id),
    ids,
  );
  const imported = new NotebookEngine(NotebookEngine.importProject(e.exportProject()));
  assert.equal(segment(imported, n, s).text, 'a+y=7');
  assert.equal(imported.validateMappings()[0].valid, true);
});
test('parallel edits to different characters in the same formula both survive', () => {
  const { e, n, s } = seed(),
    a = new NotebookEngine(e.project, 'a', 'phone'),
    b = new NotebookEngine(e.project, 'b', 'mac');
  a.editSegment(n, s, 'z+y=7');
  b.editSegment(n, s, 'x+y=9');
  a.merge(b.project);
  b.merge(a.project);
  assert.equal(segment(a, n, s).text, 'z+y=9');
  assert.equal(segment(b, n, s).text, 'z+y=9');
  assert.equal(a.state.conflicts.length, 0);
  assert.deepEqual(a.state, b.state);
});
test('overlapping edits retain both candidates and require explicit conflict resolution', () => {
  const { e, n, s } = seed(),
    a = new NotebookEngine(e.project, 'a', 'phone'),
    b = new NotebookEngine(e.project, 'b', 'mac');
  a.editSegment(n, s, 'z+y=7');
  b.editSegment(n, s, 'q+y=7');
  a.merge(b.project);
  assert.equal(a.state.conflicts.length, 1);
  assert.deepEqual(
    new Set([a.state.conflicts[0].current, a.state.conflicts[0].incoming]),
    new Set(['z', 'q']),
  );
  a.resolveConflict(a.state.conflicts[0].id, 'incoming');
  assert.equal(a.state.conflicts[0].resolved, true);
});
test('insertion and deletion preserve stable existing identities', () => {
  const { e, n, s } = seed('abc', 'text');
  e.editSegment(n, s, 'aXbc');
  assert.equal(segment(e, n, s).text, 'aXbc');
  e.editSegment(n, s, 'aXc');
  assert.equal(segment(e, n, s).text, 'aXc');
  e.editSegment(n, s, 'aYZc');
  assert.equal(segment(e, n, s).text, 'aYZc');
});
test('phone and Mac may edit existing B but cannot create papers or blocks or touch A', () => {
  const { e, n, p, s, o } = seed();
  for (const role of ['phone', 'mac'] as const) {
    const c = new NotebookEngine(e.project, role, role);
    c.editSegment(n, s, 'z+y=7');
    assert.throws(() => c.createNote());
    assert.throws(() => c.addPage(n));
    assert.throws(() => c.createBlock(n));
    assert.throws(() => c.addStroke(n, p, points));
    assert.throws(() => c.deleteObject(n, o));
    assert.throws(() => c.updateObject(n, o, { text: 'x' }));
    assert.throws(() => c.deleteSegment(n, s));
  }
});
test('B edit yields editable printed fallback at original location, preserving raw source', () => {
  const { e, n, s, o } = seed();
  const id = e.editSegment(n, s, 'z+y=7')!;
  const correction = e.state.corrections.find((c) => c.id === id)!;
  assert.equal(correction.mode, 'printed');
  const objects = e.getNote(n).pages.flatMap((p) => p.objects);
  assert.equal(objects.find((x) => x.id === correction.objectId)!.text, 'z+y=7');
  assert.deepEqual(objects.find((x) => x.id === o)!.points, points);
});
test('independent undo preserves subsequent unrelated human ink', () => {
  const { e, n, p, s } = seed();
  const revision = e.editSegment(n, s, 'z+y=7')!,
    human = e.addStroke(
      n,
      p,
      points.map((v) => ({ ...v, x: v.x + 100 })),
    );
  e.undoRevision(revision);
  assert.equal(segment(e, n, s).text, 'x+y=7');
  assert.ok(e.getNote(n).pages[0].objects.find((o) => o.id === human && !o.deleted));
  assert.equal(e.state.corrections.length, 0);
});
test('undo does not consume a later edit of the same character', () => {
  const { e, n, s } = seed();
  const first = e.editSegment(n, s, 'z+y=7')!;
  e.editSegment(n, s, 'q+y=7');
  e.undoRevision(first);
  assert.equal(segment(e, n, s).text, 'q+y=7');
  assert.equal(e.state.conflicts.filter((c) => c.kind === 'dependency').length, 1);
});
test('merging is explicitly irreversible and strips revision provenance from A', () => {
  const { e, n, s } = seed();
  const revision = e.editSegment(n, s, 'z+y=7')!;
  assert.throws(() => e.mergeRevision(revision));
  e.mergeRevision(revision, true);
  assert.throws(() => e.undoRevision(revision));
  const obj = e.getNote(n).pages[0].objects.find((o) => o.id === `revision:${revision}`)!;
  assert.equal(obj.layerId, 'ink');
  assert.equal(obj.revisionId, undefined);
  assert.equal(obj.replacesObjectIds, undefined);
  assert.equal(e.state.corrections.length, 0);
  const restored = new NotebookEngine(NotebookEngine.importProject(e.exportProject()));
  assert.throws(() => restored.undoRevision(revision));
});
test('cross-page blocks retain page identities and do not have nested block structure', () => {
  const { e, n, b } = seed();
  const p2 = e.addPage(n),
    o2 = e.addStroke(n, p2, points);
  e.recognize(n, b, [o2], 'second page', { confirmed: true });
  const block = e.getNote(n).blocks.find((x) => x.id === b)!;
  assert.equal(block.pageIds.length, 2);
  assert.equal('children' in block, false);
});
test('cross-page object-only mappings do not guess character placement', () => {
  const { e, n, b, o } = seed();
  const p2 = e.addPage(n),
    o2 = e.addStroke(n, p2, points);
  const s = e.recognize(n, b, [o, o2], 'across pages', { confirmed: true });
  const id = e.editSegment(n, s, 'across sheets')!;
  const c = e.state.corrections.find((x) => x.id === id)!;
  assert.equal(c.needsPlacement, true);
  assert.throws(() => e.mergeRevision(id, true));
  assert.equal(e.getNote(n).pages[0].objects.find((x) => x.id === o)!.deleted, undefined);
});
test('formula content is protected from automatic correction and weak typos are rejected', () => {
  const { e, n, s } = seed();
  assert.throws(() => e.correctTypo(n, s, 'x+y=8', 1));
  const t = seed('错别字', 'text');
  assert.throws(() => t.e.correctTypo(t.n, t.s, '正确字', 0.98));
  assert.equal(segment(e, n, s).text, 'x+y=7');
});
test('deleting exact A content removes B counterpart and deleting B removes exact A', () => {
  const a = seed();
  a.e.deleteObject(a.n, a.o);
  assert.equal(segment(a.e, a.n, a.s).deleted, true);
  const b = seed();
  b.e.deleteSegment(b.n, b.s);
  assert.equal(b.e.getNote(b.n).pages[0].objects.find((x) => x.id === b.o)!.deleted, true);
});
test('geometry-only translation keeps mapping; partial erasure sends source to proofreading', () => {
  const { e, n, o, s } = seed();
  const obj = e.getNote(n).pages[0].objects.find((x) => x.id === o)!;
  e.updateObject(n, o, {
    bounds: { ...obj.bounds, x: obj.bounds.x + 10, y: obj.bounds.y + 10 },
    points: points.map((v) => ({ ...v, x: v.x + 10, y: v.y + 10 })),
  });
  assert.equal(segment(e, n, s).source.status, 'exact');
  assert.equal(e.validateMappings()[0].valid, true);
  e.updateObject(n, o, { points: [{ ...points[0], x: 99 }] });
  assert.equal(segment(e, n, s).source.status, 'unmapped');
});
test('direct A text modification updates existing B segment without creating another block', () => {
  const e = new NotebookEngine(),
    n = e.createNote(),
    p = e.getNote(n).pages[0].id,
    o = e.addText(n, p, 'abc'),
    b = e.createBlock(n, 'typed', [o]),
    s = e.recognize(n, b, [o], 'abc', { deterministic: true });
  const ids = segment(e, n, s).chars.map((c) => c.id);
  e.updateObject(n, o, { text: 'axc' });
  assert.equal(segment(e, n, s).text, 'axc');
  assert.deepEqual(
    segment(e, n, s).chars.map((c) => c.id),
    ids,
  );
  assert.equal(e.state.corrections.length, 0);
});
test('projects restore metadata, all operations, histories, and enforce identity integrity', () => {
  const { e, n, s, b } = seed();
  e.project.metadata.dependencies = [{ id: 'source', snapshot: 'native-content' }];
  e.editSegment(n, s, 'x+y=8');
  const restored = new NotebookEngine(NotebookEngine.importProject(e.exportProject()));
  assert.deepEqual(restored.project.metadata, e.project.metadata);
  assert.equal(restored.getNote(n).blocks.find((x) => x.id === b)!.versions.length, 2);
  assert.deepEqual(restored.state, e.state);
  const collision = structuredClone(restored.project);
  collision.operations[0].payload.title = 'tampered';
  assert.throws(() => restored.merge(collision));
});
test('only existing user folders can be assigned and archive date is content modification date', () => {
  const { e, n } = seed();
  const before = e.getNote(n).modifiedAt;
  const id = e.createFolder('力学', '物理');
  e.manageNote(n, { folderId: id, tags: ['test'] });
  assert.equal(e.getNote(n).folderId, id);
  assert.equal(e.getNote(n).modifiedAt, before);
  assert.throws(() => e.manageNote(n, { folderId: 'ai-invented-folder' }));
});
test('same-value concurrent character edits are idempotent rather than a false conflict', () => {
  const { e, n, s } = seed(),
    a = new NotebookEngine(e.project, 'a', 'phone'),
    b = new NotebookEngine(e.project, 'b', 'mac');
  a.editSegment(n, s, 'z+y=7');
  b.editSegment(n, s, 'z+y=7');
  a.merge(b.project);
  assert.equal(segment(a, n, s).text, 'z+y=7');
  assert.equal(a.state.conflicts.length, 0);
});
test('concurrent A content edit and source deletion retain data for visible conflict resolution', () => {
  const { e, n, s, o } = seed(),
    a = new NotebookEngine(e.project, 'a', 'tablet'),
    b = new NotebookEngine(e.project, 'b', 'tablet');
  a.updateObject(n, o, { points: points.map((v) => ({ ...v, pressure: 0.9 })) });
  b.deleteObject(n, o);
  a.merge(b.project);
  assert.equal(a.state.conflicts.filter((c) => !c.resolved).length, 1);
  assert.equal(a.getNote(n).pages[0].objects.find((x) => x.id === o)!.deleted, undefined);
  assert.equal(segment(a, n, s).deleted, undefined);
  a.resolveConflict(a.state.conflicts[0].id, 'incoming');
  assert.equal(segment(a, n, s).deleted, true);
});
test('deleting a B segment also removes all unmerged A revision layers', () => {
  const { e, n, s } = seed();
  e.editSegment(n, s, 'z+y=7');
  e.deleteSegment(n, s);
  assert.equal(
    e
      .getNote(n)
      .pages.flatMap((p) => p.objects)
      .filter((o) => o.revisionId && !o.deleted).length,
    0,
  );
  assert.equal(e.state.corrections.length, 0);
});
test('concurrent B edit and A deletion become a conflict even if deletion replays first', () => {
  const { e, n, s, o } = seed(),
    a = new NotebookEngine(e.project, 'a', 'tablet'),
    b = new NotebookEngine(e.project, 'z', 'phone');
  a.deleteObject(n, o);
  b.editSegment(n, s, 'z+y=7');
  a.merge(b.project);
  assert.equal(segment(a, n, s).text, 'z+y=7');
  assert.equal(a.state.conflicts.filter((c) => !c.resolved).length, 1);
});
test('duplicate character map indices cannot fabricate character-level precision', () => {
  const { e, n, b, o } = seed();
  assert.throws(() =>
    e.recognize(n, b, [o], 'ab', {
      confirmed: true,
      charMap: [
        { index: 0, objectIds: [o] },
        { index: 0, objectIds: [o] },
      ],
    }),
  );
  assert.throws(() =>
    e.recognize(n, b, [o], 'a', { confirmed: true, charMap: [{ index: 0, objectIds: [] }] }),
  );
});
test('explicit character selection preserves non-overlap intent in repeated symbols', () => {
  const { e, n, s } = seed('aa', 'text'),
    a = new NotebookEngine(e.project, 'a', 'phone'),
    b = new NotebookEngine(e.project, 'b', 'mac');
  assert.throws(() => a.editSegment(n, s, 'a'));
  a.editRange(n, s, 0, 1, '');
  b.editRange(n, s, 1, 2, 'b');
  a.merge(b.project);
  assert.equal(segment(a, n, s).text, 'b');
  assert.equal(a.state.conflicts.length, 0);
});
test('reference-description editing never replaces the original diagram with text', () => {
  const { e, n, b, o } = seed();
  const s = e.recognize(n, b, [o], '原图说明', { kind: 'reference', confirmed: true });
  e.editSegment(n, s, '新说明');
  assert.equal(e.state.corrections.length, 0);
  assert.equal(e.getNote(n).pages[0].objects.find((x) => x.id === o)!.deleted, undefined);
});
test('resolving an obsolete preview cannot overwrite a later valid character edit', () => {
  const { e, n, s } = seed(),
    a = new NotebookEngine(e.project, 'a', 'phone'),
    b = new NotebookEngine(e.project, 'b', 'mac');
  a.editSegment(n, s, 'z+y=7');
  b.editSegment(n, s, 'q+y=7');
  a.merge(b.project);
  const old = new NotebookEngine(a.project, 'z-old', 'phone'),
    newer = new NotebookEngine(a.project, 'c-new', 'mac');
  old.resolveConflict(old.state.conflicts[0].id, 'incoming');
  newer.editSegment(n, s, 'r+y=7');
  old.merge(newer.project);
  assert.equal(segment(old, n, s).text, 'r+y=7');
  assert.ok(old.state.conflicts.some((c) => !c.resolved));
});
test('merged operation equality ignores JSON property order but preserves content integrity', () => {
  const { e } = seed();
  const reordered = JSON.parse(
    JSON.stringify(e.project, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ),
  );
  assert.doesNotThrow(() => e.merge(reordered));
});
test('automatic typo APIs require a reviewed prose rule rather than arbitrary rewrites', () => {
  const { e, n, s } = seed('这是既使', 'text');
  assert.throws(() => e.correctTypo(n, s, '这是即使', 1));
  assert.throws(() =>
    e.correctTypo(n, s, '这是即使', 1, {
      id: 'x',
      from: '知识',
      to: '事实',
      contentKind: 'prose',
      authorized: true,
    }),
  );
});
test('draft recovery uses immutable draft identity to avoid duplicate ink after a crash', () => {
  const { e, n, p } = seed();
  const a = e.addStroke(n, p, points, { draftId: 'recoverable-stroke' }),
    b = e.addStroke(n, p, points, { draftId: 'recoverable-stroke' });
  assert.equal(a, b);
  assert.equal(
    e.project.operations.filter((op) => op.payload.draftId === 'recoverable-stroke').length,
    1,
  );
  const restored = new NotebookEngine(NotebookEngine.importProject(e.exportProject()));
  assert.equal(restored.addStroke(n, p, points, { draftId: 'recoverable-stroke' }), a);
});
test('B jumps to the effective A revision while retaining original source identities', () => {
  const { e, n, s, o } = seed();
  const revision = e.editSegment(n, s, 'z+y=7')!;
  const correspondence = e.findCorrespondence(n, s);
  assert.equal(correspondence.status, 'exact');
  assert.deepEqual(correspondence.objectIds, [`revision:${revision}`]);
  assert.deepEqual(correspondence.originalSourceIds, [o]);
});
test('proofreading reconfirms existing segment identity against current source versions', () => {
  const { e, n, s, o } = seed();
  e.updateObject(n, o, { points: [points[0]] });
  assert.equal(segment(e, n, s).source.status, 'unmapped');
  const ids = segment(e, n, s).chars.map((c) => c.id);
  e.confirmMapping(n, s, [o]);
  assert.equal(segment(e, n, s).source.status, 'exact');
  assert.equal(e.validateMappings()[0].valid, true);
  assert.deepEqual(
    segment(e, n, s).chars.map((c) => c.id),
    ids,
  );
  const phone = new NotebookEngine(e.project, 'phone', 'phone');
  assert.throws(() => phone.confirmMapping(n, s, [o]));
});
test('different-field changes of one A object merge without a false conflict', () => {
  const { e, n, o } = seed(),
    a = new NotebookEngine(e.project, 'a', 'tablet'),
    b = new NotebookEngine(e.project, 'b', 'tablet');
  a.updateObject(n, o, { color: '#ff0000' });
  const obj = b.getNote(n).pages[0].objects.find((x) => x.id === o)!;
  b.updateObject(n, o, {
    bounds: { ...obj.bounds, x: obj.bounds.x + 20 },
    points: points.map((v) => ({ ...v, x: v.x + 20 })),
  });
  a.merge(b.project);
  const merged = a.getNote(n).pages[0].objects.find((x) => x.id === o)!;
  assert.equal(merged.color, '#ff0000');
  assert.equal(merged.bounds.x, obj.bounds.x + 20);
  assert.equal(a.state.conflicts.length, 0);
});
test('B symbol changes do not retain a false exact link to the old handwritten glyph', () => {
  const { e, n, s } = seed();
  e.editSegment(n, s, 'z+y=7');
  const seg = segment(e, n, s);
  assert.equal(seg.source.precision, 'object');
  assert.equal(seg.chars[0].glyphIds, undefined);
  assert.equal(e.findCorrespondence(n, s).precision, 'object');
});
test('non-overlapping direct A text and B edits agree in the effective revision layer', () => {
  const e = new NotebookEngine(undefined, 'seed'),
    n = e.createNote(),
    p = e.getNote(n).pages[0].id,
    o = e.addText(n, p, 'abc'),
    b = e.createBlock(n, 'typed', [o]),
    s = e.recognize(n, b, [o], 'abc', { deterministic: true });
  const a = new NotebookEngine(e.project, 'z-A', 'tablet'),
    remote = new NotebookEngine(e.project, 'a-B', 'phone');
  a.updateObject(n, o, { text: 'xbc' });
  remote.editSegment(n, s, 'aby');
  a.merge(remote.project);
  assert.equal(segment(a, n, s).text, 'xby');
  const effective = a.findCorrespondence(n, s).objectIds;
  assert.equal(a.getNote(n).pages[0].objects.find((o) => o.id === effective[0])!.text, 'xby');
});
test('direct editing of a printed A revision updates the existing B segment', () => {
  const { e, n, s } = seed();
  const revision = e.editSegment(n, s, 'z+y=7')!;
  e.updateObject(n, `revision:${revision}`, { text: 'z+y=9' });
  assert.equal(segment(e, n, s).text, 'z+y=9');
  assert.equal(
    e.getNote(n).pages[0].objects.find((o) => o.id === `revision:${revision}`)!.text,
    'z+y=9',
  );
});
test('undoing an AI layer preserves a later independent edit made directly on its A text', () => {
  const { e, n, s } = seed();
  const original = e.editSegment(n, s, 'z+y=7')!;
  e.updateObject(n, `revision:${original}`, { text: 'z+y=9' });
  e.undoRevision(original);
  assert.equal(segment(e, n, s).text, 'x+y=9');
  const effective = e.findCorrespondence(n, s).objectIds;
  assert.equal(e.getNote(n).pages[0].objects.find((o) => o.id === effective[0])!.text, 'x+y=9');
  assert.ok(e.state.undoneRevisionIds.includes(original));
});
test('dependency-preview choice keeps later human content and finishes the requested independent undo', () => {
  const { e, n, s } = seed();
  const original = e.editSegment(n, s, 'z+y=7')!;
  e.updateObject(n, `revision:${original}`, { text: 'q+y=7' });
  e.undoRevision(original);
  const dependency = e.state.conflicts.find((c) => c.undoRevisionId === original && !c.resolved)!;
  e.resolveConflict(dependency.id, 'current');
  assert.equal(segment(e, n, s).text, 'q+y=7');
  const effective = e.findCorrespondence(n, s).objectIds;
  assert.equal(e.getNote(n).pages[0].objects.find((o) => o.id === effective[0])!.text, 'q+y=7');
  assert.ok(e.state.undoneRevisionIds.includes(original));
});
test('invalid packages are rejected atomically before replacing a usable project', () => {
  const { e } = seed();
  for (const mutate of [
    (x: any) => {
      x.project.operations[0].seq = null;
    },
    (x: any) => {
      x.project.operations.find(
        (o: any) => o.type === 'object.create',
      ).payload.object.points[0].pressure = null;
    },
    (x: any) => {
      x.project.id = 7;
    },
    (x: any) => {
      x.project.operations.push(x.project.operations[0]);
    },
  ]) {
    const json = JSON.parse(e.exportProject());
    mutate(json);
    assert.throws(() => NotebookEngine.importProject(JSON.stringify(json)));
  }
  assert.equal(e.state.notes.length, 1);
});
test('character precision requires distinct, real source glyph identities', () => {
  const { e, n, p, b, o } = seed();
  assert.throws(() =>
    e.recognize(n, b, [o], 'a', {
      confirmed: true,
      charMap: [{ index: 0, objectIds: [o], glyphIds: ['invented-glyph'] }],
    }),
  );
  const o2 = e.addStroke(
    n,
    p,
    points.map((p) => ({ ...p, x: p.x + 40 })),
  );
  const s = e.recognize(n, b, [o, o2], 'ab', {
    confirmed: true,
    charMap: [
      { index: 0, objectIds: [o], glyphIds: [o] },
      { index: 1, objectIds: [o2], glyphIds: [o2] },
    ],
  });
  assert.equal(segment(e, n, s).source.precision, 'character');
});
test('transcription proofreading corrects B and confirms source without changing or covering A', () => {
  const { e, n, s, o } = seed();
  const raw = structuredClone(e.getNote(n).pages);
  e.correctTranscription(n, s, 'x+y=9', [o]);
  assert.equal(segment(e, n, s).text, 'x+y=9');
  assert.equal(segment(e, n, s).source.status, 'exact');
  assert.equal(segment(e, n, s).source.precision, 'object');
  assert.deepEqual(e.getNote(n).pages, raw);
  assert.equal(e.state.corrections.length, 0);
  assert.throws(() =>
    new NotebookEngine(e.project, 'phone', 'phone').correctTranscription(n, s, 'x+y=8', [o]),
  );
});
test('proofreading preserves existing segment and unchanged character IDs across repeated-symbol correction', () => {
  const { e, n, s, o } = seed('aa', 'text'),
    id = segment(e, n, s).chars[0].id;
  e.correctTranscription(n, s, 'a', [o]);
  assert.equal(segment(e, n, s).id, s);
  assert.equal(segment(e, n, s).chars.filter((c) => !c.deleted)[0].id, id);
  assert.equal(e.state.corrections.length, 0);
});
function multiBlockSeed() {
  const base = seed('one', 'text');
  const o2 = base.e.addStroke(
      base.n,
      base.p,
      points.map((v) => ({ ...v, x: v.x + 60 })),
    ),
    s2 = base.e.recognize(base.n, base.b, [o2], 'two', { confirmed: true }),
    p2 = base.e.addPage(base.n),
    o3 = base.e.addStroke(base.n, p2, points),
    s3 = base.e.recognize(base.n, base.b, [o3], 'three', { confirmed: true });
  return { ...base, o2, s2, p2, o3, s3 };
}
test('tablet split moves selected segments across pages without changing any A object or identity', () => {
  const { e, n, b, s, s2, s3 } = multiBlockSeed(),
    before = structuredClone(e.getNote(n).pages),
    chars = segment(e, n, s3).chars.map((c) => c.id);
  const created = e.splitBlock(n, b, [s2, s3], '后续推导');
  const note = e.getNote(n),
    original = note.blocks.find((x) => x.id === b)!,
    split = note.blocks.find((x) => x.id === created)!;
  assert.deepEqual(
    original.segments.map((x) => x.id),
    [s],
  );
  assert.deepEqual(
    split.segments.map((x) => x.id),
    [s2, s3],
  );
  assert.equal(split.pageIds.length, 2);
  assert.deepEqual(
    split.segments[1].chars.map((c) => c.id),
    chars,
  );
  assert.equal(split.segments[1].blockId, created);
  assert.deepEqual(note.pages, before);
  assert.ok(e.state.blockArchive.some((a) => a.block.id === b && a.block.segments.length === 3));
  assert.throws(() => e.splitBlock(n, b, [s]));
});
test('block merge keeps the first stable block identity, complete history, and cross-note relationships', () => {
  const { e, n, b, s2, s3 } = multiBlockSeed(),
    split = e.splitBlock(n, b, [s2, s3], '后续');
  const otherNote = e.createNote('其他笔记'),
    other = e.createBlock(otherNote, '外部关系');
  e.linkBlocks(otherNote, other, split);
  e.linkBlocks(n, split, other);
  const raw = structuredClone(e.getNote(n).pages),
    merged = e.mergeBlocks(n, [b, split], '完整推导');
  assert.equal(merged, b);
  assert.equal(e.getNote(n).blocks.length, 1);
  assert.equal(e.getNote(n).blocks[0].segments.length, 3);
  assert.equal(e.getNote(n).blocks[0].versions.length, 3);
  assert.equal(e.resolveBlockId(split), b);
  assert.deepEqual(e.getNote(otherNote).blocks[0].relatedBlockIds, [b]);
  assert.deepEqual(e.getNote(n).blocks[0].relatedBlockIds, [other]);
  assert.deepEqual(e.getNote(n).pages, raw);
  const restored = new NotebookEngine(NotebookEngine.importProject(e.exportProject()));
  assert.equal(restored.resolveBlockId(split), b);
  assert.equal(restored.state.blockArchive.length, e.state.blockArchive.length);
});
test('phone and Mac cannot split or merge blocks, including imported unauthorized operations', () => {
  const { e, n, b, s2 } = multiBlockSeed();
  for (const role of ['phone', 'mac'] as const) {
    const remote = new NotebookEngine(e.project, role, role);
    assert.throws(() => remote.splitBlock(n, b, [s2], 'new'));
    assert.throws(() => remote.mergeBlocks(n, [b, 'other'], 'merged'));
  }
  const split = e.splitBlock(n, b, [s2], 'new'),
    tampered = structuredClone(e.project);
  tampered.operations.at(-1)!.role = 'phone';
  assert.throws(() => new NotebookEngine(tampered));
  assert.ok(split);
});
test('non-overlapping concurrent block split and B edit retain all content and stable ownership', () => {
  const { e, n, b, s, s2 } = multiBlockSeed(),
    a = new NotebookEngine(e.project, 'a', 'tablet'),
    remote = new NotebookEngine(e.project, 'b', 'phone');
  const created = a.splitBlock(n, b, [s2], 'split');
  remote.editSegment(n, s, 'ONE');
  a.merge(remote.project);
  assert.equal(segment(a, n, s).text, 'ONE');
  assert.equal(segment(a, n, s2).blockId, created);
  assert.equal(a.state.conflicts.length, 0);
});
test('disjoint concurrent splits retain both new blocks and every segment', () => {
  const { e, n, b, s, s2 } = multiBlockSeed(),
    a = new NotebookEngine(e.project, 'a', 'tablet'),
    remote = new NotebookEngine(e.project, 'b', 'tablet');
  const first = a.splitBlock(n, b, [s], 'first'),
    second = remote.splitBlock(n, b, [s2], 'second');
  a.merge(remote.project);
  assert.equal(segment(a, n, s).blockId, first);
  assert.equal(segment(a, n, s2).blockId, second);
  assert.equal(a.state.conflicts.length, 0);
});
test('competing split ownership is a visible structural conflict and user choice preserves A', () => {
  const { e, n, b, s } = multiBlockSeed(),
    a = new NotebookEngine(e.project, 'a', 'tablet'),
    remote = new NotebookEngine(e.project, 'z', 'tablet');
  const first = a.splitBlock(n, b, [s], 'first'),
    second = remote.splitBlock(n, b, [s], 'second');
  a.merge(remote.project);
  const conflict = a.state.conflicts.find((c) => c.kind === 'structure' && !c.resolved)!;
  assert.ok(conflict);
  assert.equal(segment(a, n, s).blockId, first);
  const before = structuredClone(a.getNote(n).pages);
  a.resolveConflict(conflict.id, 'incoming');
  assert.equal(segment(a, n, s).blockId, second);
  assert.deepEqual(a.getNote(n).pages, before);
});
test('knowledge references to an obsolete merged block resolve to its active survivor', () => {
  const { e, n, b, s2 } = multiBlockSeed(),
    second = e.splitBlock(n, b, [s2], 'second');
  e.mergeBlocks(n, [b, second], 'merged');
  const o = e.getNote(n).pages[0].objects[0].id,
    s = e.recognize(n, second, [o], 'later', { confirmed: true });
  assert.equal(segment(e, n, s).blockId, b);
});
test('concurrent replay uses a locale-independent total order for mixed-case writer identities', () => {
  const { e, n, s } = seed('ab', 'text'),
    lower = new NotebookEngine(e.project, 'a-writer', 'phone'),
    upper = new NotebookEngine(e.project, 'A-writer', 'mac');
  lower.editRange(n, s, 0, 1, 'L');
  upper.editRange(n, s, 0, 1, 'U');
  const combined = {
    ...e.project,
    operations: [
      ...lower.project.operations,
      ...upper.project.operations.filter(
        (op) => !lower.project.operations.some((old) => old.id === op.id),
      ),
    ],
  };
  const forward = new NotebookEngine(combined),
    backward = new NotebookEngine({ ...combined, operations: [...combined.operations].reverse() });
  assert.equal(segment(forward, n, s).text, 'Ub');
  assert.equal(segment(backward, n, s).text, 'Ub');
  assert.equal(forward.state.conflicts[0].current, 'U');
  assert.deepEqual(forward.state.conflicts, backward.state.conflicts);
});
