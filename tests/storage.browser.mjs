import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Run against the Vite development server, independently from UI state and seed data.
const base = process.env.QUIET_PAPER_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const context = await browser.newContext();
  const first = await context.newPage(),
    second = await context.newPage();
  await Promise.all([
    first.goto(`${base}/tests/fixtures/storage-harness.html`),
    second.goto(`${base}/tests/fixtures/storage-harness.html`),
  ]);

  const seeded = await first.evaluate(async () => {
    const { NotebookEngine } = await import('/src/domain.ts');
    const { saveWorkspace, writeLocal } = await import('/src/storage.ts');
    const e = new NotebookEngine(undefined, 'browser-seed', 'tablet');
    const noteId = e.createNote('Crash recovery');
    const pageId = e.getNote(noteId).pages[0].id;
    const points = [
      { x: 1, y: 2, pressure: 0.7, tiltX: 12, tiltY: -8, time: 1 },
      { x: 3, y: 4, pressure: 0.9, tiltX: 15, tiltY: -9, time: 2 },
    ];
    const strokeId = e.addStroke(noteId, pageId, points, {
      layerId: 'human-ink',
      width: 2.4,
      draftId: 'finished-stroke',
    });
    const epoch = crypto.randomUUID();
    await saveWorkspace(
      { project: e.project, epoch, cursor: 7, syncIdentity: 'test-identity' },
      { expectedEpoch: null },
    );
    const draft = {
      id: 'interrupted-stroke',
      projectId: e.project.id,
      noteId,
      pageId,
      points: [...points, { x: 5, y: 7, pressure: 0.3, tiltX: 2, tiltY: 4, time: 3 }],
      color: '#123456',
      width: 3,
      layerId: 'ink',
    };
    await writeLocal('draft:acceptance-a', draft);
    await writeLocal('draft:acceptance-b', { ...draft, color: '#654321' });
    return { project: e.project, epoch, noteId, pageId, points, strokeId, draft };
  });
  await first.reload();
  const recovered = await first.evaluate(async ({ noteId, strokeId }) => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    const stored = await readLocal('current');
    const e = new NotebookEngine(stored.project, 'browser-recovery', 'tablet');
    const stroke = e
      .getNote(noteId)
      .pages.flatMap((p) => p.objects)
      .find((o) => o.id === strokeId);
    return { stored, stroke, draft: await readLocal('draft:acceptance-a') };
  }, seeded);
  assert.deepEqual(recovered.stroke.points, seeded.points);
  assert.equal(recovered.stroke.layerId, 'human-ink');
  assert.equal(recovered.stored.cursor, 7);
  assert.deepEqual(recovered.draft, seeded.draft);
  console.log(
    'PASS: strict IndexedDB commit survives page reload with pressure/tilt/layers/cursor and an interrupted draft.',
  );

  const projects = await first.evaluate(async (baseProject) => {
    const { NotebookEngine } = await import('/src/domain.ts');
    const a = new NotebookEngine(baseProject, 'window-a', 'tablet'),
      b = new NotebookEngine(baseProject, 'window-b', 'tablet');
    a.createNote('Window A');
    b.createNote('Window B');
    return { a: a.project, b: b.project };
  }, seeded.project);
  await Promise.all([
    first.evaluate(
      async ({ project, epoch }) => {
        const { saveWorkspace } = await import('/src/storage.ts');
        await saveWorkspace({ project, epoch });
      },
      { project: projects.a, epoch: seeded.epoch },
    ),
    second.evaluate(
      async ({ project, epoch }) => {
        const { saveWorkspace } = await import('/src/storage.ts');
        await saveWorkspace({ project, epoch });
      },
      { project: projects.b, epoch: seeded.epoch },
    ),
  ]);
  const combined = await second.evaluate(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    const stored = await readLocal('current');
    const e = new NotebookEngine(stored.project);
    return {
      project: stored.project,
      titles: e.state.notes.map((n) => n.title),
      draft: await readLocal('draft:acceptance-a'),
    };
  });
  assert.equal(combined.project.operations.length, seeded.project.operations.length + 2);
  assert(combined.titles.includes('Window A'));
  assert(combined.titles.includes('Window B'));
  assert.deepEqual(combined.draft, seeded.draft);
  console.log(
    'PASS: concurrent saves from stale snapshots in two real browser windows retain both immutable journals.',
  );

  const tampered = structuredClone(combined.project);
  tampered.operations[0].payload.title = 'identity collision';
  const rejection = await first.evaluate(
    async ({ project, epoch }) => {
      const { saveWorkspace, readLocal } = await import('/src/storage.ts');
      try {
        await saveWorkspace(
          { project, epoch },
          {
            consumeDraft: {
              key: 'draft:acceptance-a',
              expected: await readLocal('draft:acceptance-a'),
            },
          },
        );
        return { rejected: false };
      } catch (error) {
        return {
          rejected: true,
          message: String(error),
          saved: (await readLocal('current')).project,
        };
      }
    },
    { project: tampered, epoch: seeded.epoch },
  );
  assert.equal(rejection.rejected, true);
  assert.deepEqual(rejection.saved, combined.project);
  console.log(
    'PASS: operation-ID collision aborts the IDB transaction and leaves the prior database intact.',
  );

  const recoveredProject = await first.evaluate(
    async ({ project, draft, epoch }) => {
      const { saveWorkspace, readLocal } = await import('/src/storage.ts');
      const { NotebookEngine } = await import('/src/domain.ts');
      const e = new NotebookEngine(project, 'draft-recovery-window', 'tablet');
      e.addStroke(draft.noteId, draft.pageId, draft.points, { ...draft, draftId: draft.id });
      await saveWorkspace(
        { project: e.project, epoch, draft: null },
        { consumeDraft: { key: 'draft:acceptance-a', expected: draft } },
      );
      return e.project;
    },
    { project: combined.project, draft: seeded.draft, epoch: seeded.epoch },
  );
  const draftsAfterCommit = await second.evaluate(async () => {
    const { readLocal } = await import('/src/storage.ts');
    return {
      own: await readLocal('draft:acceptance-a'),
      other: await readLocal('draft:acceptance-b'),
    };
  });
  assert.equal(draftsAfterCommit.own, undefined);
  assert.equal(draftsAfterCommit.other.color, '#654321');
  assert.equal(recoveredProject.operations.length, combined.project.operations.length + 1);
  console.log(
    'PASS: recovered ink commit and exact checkpoint consumption complete in one strict transaction; another window draft stays intact.',
  );

  const duplicateResult = await second.evaluate(
    async ({ project, draft }) => {
      const { NotebookEngine } = await import('/src/domain.ts');
      const e = new NotebookEngine(project, 'restart-after-recovery', 'tablet');
      e.addStroke(draft.noteId, draft.pageId, draft.points, { ...draft, draftId: draft.id });
      return e.project.operations.length;
    },
    { project: recoveredProject, draft: seeded.draft },
  );
  assert.equal(duplicateResult, recoveredProject.operations.length);
  console.log(
    'PASS: replay of the same stable draft identity after restart does not duplicate the committed stroke.',
  );

  const guardResult = await first.evaluate(
    async ({ project, oldDraft, epoch }) => {
      const { writeLocal, saveWorkspace, readLocal, listDrafts } = await import('/src/storage.ts');
      const newer = {
        ...oldDraft,
        id: 'new-gesture',
        points: [
          ...oldDraft.points,
          { x: 22, y: 33, pressure: 0.4, tiltX: 1, tiltY: 2, time: 444 },
        ],
      };
      await writeLocal('draft:acceptance-a', newer);
      await saveWorkspace(
        { project, epoch },
        { consumeDraft: { key: 'draft:acceptance-a', expected: oldDraft } },
      );
      sessionStorage.clear(); // Simulate a replacement WebView with no remembered tab identity.
      return { draft: await readLocal('draft:acceptance-a'), listed: await listDrafts(), newer };
    },
    { project: recoveredProject, oldDraft: seeded.draft, epoch: seeded.epoch },
  );
  assert.deepEqual(guardResult.draft, guardResult.newer);
  assert(
    guardResult.listed.some(
      (entry) => entry.key === 'draft:acceptance-a' && entry.draft.id === 'new-gesture',
    ),
  );
  assert(guardResult.listed.some((entry) => entry.key === 'draft:acceptance-b'));
  console.log(
    'PASS: stale consumption cannot erase a newer gesture; orphan drafts remain discoverable after tab session identity is lost.',
  );
  const restoration = await first.evaluate(
    async ({ project, oldEpoch }) => {
      const { replaceWorkspace, readLocal, listRecoveries } = await import('/src/storage.ts');
      const previous = await readLocal('current');
      const next = await replaceWorkspace({ project, cursor: 0 }, oldEpoch, previous);
      const stored = await readLocal('current');
      return { next, stored, recoveries: await listRecoveries() };
    },
    { project: seeded.project, oldEpoch: seeded.epoch },
  );
  assert.deepEqual(restoration.stored.project, seeded.project);
  assert.notEqual(restoration.next.epoch, seeded.epoch);
  assert(
    restoration.recoveries.some(
      (item) =>
        item.recovery.workspace.project.operations.length > seeded.project.operations.length,
    ),
  );
  console.log(
    'PASS: explicit same-project restore atomically replaces the newer journal and retains a complete recovery snapshot.',
  );

  const stale = await second.evaluate(
    async ({ project, epoch }) => {
      const { saveWorkspace, readLocal, listRecoveries } = await import('/src/storage.ts');
      const { NotebookEngine } = await import('/src/domain.ts');
      const old = new NotebookEngine(project, 'late-old-window', 'tablet');
      old.createNote('Late stale write');
      try {
        await saveWorkspace({ project: old.project, epoch });
        return { rejected: false };
      } catch (error) {
        return {
          rejected: true,
          code: error.code,
          current: await readLocal('current'),
          recoveries: await listRecoveries(),
        };
      }
    },
    { project: recoveredProject, epoch: seeded.epoch },
  );
  assert.equal(stale.rejected, true);
  assert.equal(stale.code, 'WORKSPACE_CHANGED');
  assert.deepEqual(stale.current.project, seeded.project);
  assert(
    stale.recoveries.some((item) =>
      item.recovery.workspace.project.operations.some(
        (op) => op.payload.title === 'Late stale write',
      ),
    ),
  );
  console.log(
    'PASS: a stale tab cannot overwrite a restored workspace; its later local ink/journal is preserved as an accessible recovery snapshot.',
  );

  const other = await second.evaluate(async (oldEpoch) => {
    const { NotebookEngine } = await import('/src/domain.ts');
    const { saveWorkspace, readLocal, replaceWorkspace } = await import('/src/storage.ts');
    const foreign = new NotebookEngine(undefined, 'foreign', 'tablet');
    foreign.createNote('Another project');
    const expected = (await readLocal('current')).epoch;
    let regularRejected = false,
      staleRestoreRejected = false;
    try {
      await saveWorkspace({ project: foreign.project, epoch: expected });
    } catch {
      regularRejected = true;
    }
    try {
      await replaceWorkspace({ project: foreign.project }, oldEpoch);
    } catch {
      staleRestoreRejected = true;
    }
    return { regularRejected, staleRestoreRejected, current: await readLocal('current') };
  }, seeded.epoch);
  assert(other.regularRejected);
  assert(other.staleRestoreRejected);
  assert.deepEqual(other.current.project, seeded.project);
  console.log(
    'PASS: regular saves cannot change project identity, and an outdated restore confirmation fails its generation compare.',
  );
  console.log('Storage browser acceptance: 9 checks passed.');
  await context.close();
} finally {
  await browser.close();
}
