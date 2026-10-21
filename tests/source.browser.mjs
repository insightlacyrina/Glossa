import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Integration with a simulated Android document bridge; not a physical Android/SAF claim.
const base = process.env.QUIET_PAPER_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox'],
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
async function until(check, message, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error(message);
}
await page.addInitScript(() => {
  const state = {
    text: 'base\n',
    sha256: 'sha:base',
    reads: [],
    saves: [],
    pending: null,
    archives: [],
    failRead: false,
    failWrite: false,
    holdSave: false,
    releaseSave: null,
  };
  window.__sourceNative = state;
  const reply = (id, result) =>
    window.dispatchEvent(
      new CustomEvent('quietpaper-native', { detail: { requestId: id, ...result } }),
    );
  async function durableRecord() {
    const { readLocal } = await import('/src/storage.ts'),
      { NotebookEngine } = await import('/src/domain.ts');
    const stored = await readLocal('current');
    if (!stored) return null;
    return Object.entries(new NotebookEngine(stored.project).state.settings).find(([key]) =>
      key.startsWith('source:'),
    )?.[1];
  }
  window.QuietPaperNative = {
    getRole: () => 'tablet',
    getDeviceId: () => 'source-install',
    readDocument: async (id) => {
      try {
        const record = await durableRecord();
        state.reads.push({ queued: record?.link.queued.length, paper: record?.link.paperContent });
        if (state.failRead) {
          reply(id, {
            ok: false,
            type: 'readDocument',
            error: 'simulated source unavailable',
            unavailable: true,
          });
          return;
        }
        reply(id, {
          ok: true,
          type: 'readDocument',
          uri: 'content://source',
          name: 'source.md',
          text: state.text,
          sha256: state.sha256,
        });
      } catch (error) {
        reply(id, { ok: false, error: String(error) });
      }
    },
    getPendingSource: async (id, uri) => {
      reply(id, {
        ok: true,
        type: 'pending-source',
        uri,
        pending: !!state.pending,
        ...(state.pending ?? {}),
      });
    },
    saveDocumentVersioned: async (id, uri, text, expectedSha256, expectedPendingSha256) => {
      try {
        const record = await durableRecord();
        state.saves.push({
          text,
          expectedSha256,
          expectedPendingSha256,
          queued: record?.link.queued.length,
          planned: !!record?.plannedWrite,
        });
        if (expectedPendingSha256 !== (state.pending?.sha256 ?? ''))
          throw new Error('pending-content-changed');
        if (state.pending) state.archives.push({ ...state.pending });
        state.pending = { text, sha256: 'sha:' + text, baseSha256: expectedSha256 };
        if (state.holdSave)
          await new Promise((resolve) => {
            state.releaseSave = resolve;
          });
        if (state.text === text) {
          state.pending = null;
          reply(id, { ok: true, type: 'saveDocumentVersioned', uri, sha256: state.sha256 });
          return;
        }
        if (state.failWrite) throw new Error('simulated source write failure');
        if (expectedSha256 !== state.sha256) throw new Error('source changed before write');
        state.text = text;
        state.sha256 = 'sha:' + text;
        state.pending = null;
        reply(id, { ok: true, type: 'saveDocumentVersioned', uri, sha256: state.sha256 });
      } catch (error) {
        reply(id, {
          ok: false,
          type: 'saveDocumentVersioned',
          error: String(error),
          pending: !!state.pending,
        });
      }
    },
  };
});
try {
  await page.goto(`${base}/tests/fixtures/storage-harness.html`);
  const ids = await page.evaluate(async () => {
    const { NotebookEngine } = await import('/src/domain.ts'),
      { openNative, createNativeLink } = await import('/src/formats.ts'),
      { saveWorkspace } = await import('/src/storage.ts');
    const e = new NotebookEngine(undefined, 'source-seed', 'tablet'),
      noteId = e.createNote('源协调验收'),
      pageId = e.getNote(noteId).pages[0].id;
    const document = openNative('source.md', 'base\n'),
      paperObjectId = e.addText(noteId, pageId, 'base\n');
    const block = e.createBlock(noteId, '源对象', [paperObjectId]),
      segmentId = e.recognize(noteId, block, [paperObjectId], 'base\n', { deterministic: true });
    e.editSegment(noteId, segmentId, 'paper\n');
    const link = createNativeLink(document, document.objects[0].id);
    e.setSetting('source:' + link.id, {
      document,
      link,
      paperObjectId,
      noteId,
      pageId,
      uri: 'content://source',
      sha256: 'sha:base',
      ownerDeviceId: 'source-install',
    });
    await saveWorkspace(
      { project: e.project, epoch: 'source-test-epoch' },
      { expectedEpoch: null },
    );
    return { noteId, pageId, segmentId, linkId: link.id, paperObjectId };
  });
  async function snapshot() {
    return page.evaluate(async (ids) => {
      const { readLocal } = await import('/src/storage.ts'),
        { NotebookEngine } = await import('/src/domain.ts');
      const stored = await readLocal('current'),
        e = new NotebookEngine(stored.project),
        note = e.getNote(ids.noteId);
      return {
        record: e.state.settings['source:' + ids.linkId],
        segment: note.blocks.flatMap((b) => b.segments).find((s) => s.id === ids.segmentId),
        sourceEvents: stored.project.operations.filter(
          (op) => op.type === 'setting.set' && op.payload.key === 'source:' + ids.linkId,
        ).length,
      };
    }, ids);
  }
  async function remoteEdit(text) {
    await page.evaluate(
      async ({ ids, text }) => {
        const { readLocal, saveWorkspace } = await import('/src/storage.ts'),
          { NotebookEngine } = await import('/src/domain.ts');
        const stored = await readLocal('current'),
          e = new NotebookEngine(stored.project, 'parallel:' + crypto.randomUUID(), 'tablet');
        e.editSegment(ids.noteId, ids.segmentId, text);
        await saveWorkspace({ ...stored, project: e.project });
        const channel = new BroadcastChannel('quiet-paper-changes');
        channel.postMessage({ projectId: e.project.id, epoch: stored.epoch });
        channel.close();
      },
      { ids, text },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.goto(base);
  await page.locator('.paper-sheet').waitFor();
  await focus();
  await until(
    async () =>
      (await snapshot()).record.link.status === 'clean' &&
      (await page.evaluate(() => window.__sourceNative.text === 'paper\n')),
    'initial native source write did not finish',
  );
  const first = await page.evaluate(() => window.__sourceNative);
  assert(first.reads[0].queued > 0);
  assert.equal(first.reads[0].paper, 'paper\n');
  assert(first.saves[0].queued > 0);
  assert.equal(first.saves[0].planned, true);
  console.log('PASS: B intent and source write plan are durably stored before native read/write.');

  const noOpBefore = (await snapshot()).sourceEvents;
  await focus();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await focus();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await snapshot()).sourceEvents, noOpBefore);
  console.log('PASS: unchanged source polling does not append whole-document settings events.');

  await page.evaluate(() => {
    window.__sourceNative.failWrite = true;
  });
  await remoteEdit('second\n');
  await focus();
  await until(
    async () => (await snapshot()).record.link.writeError?.includes('simulated'),
    'source failure was not retained',
  );
  let saved = await snapshot();
  assert.equal(saved.segment.text, 'second\n');
  assert(saved.record.link.queued.length > 0);
  assert.equal(await page.evaluate(() => window.__sourceNative.text), 'paper\n');
  console.log(
    'PASS: native write failure preserves the queued edit, paper content, and recovery plan.',
  );

  await remoteEdit('third\n');
  await page.evaluate(() => {
    window.__sourceNative.failWrite = false;
    window.__sourceNative.holdSave = true;
  });
  await focus();
  await until(
    () => page.evaluate(() => !!window.__sourceNative.releaseSave),
    'held source save did not start',
  );
  assert.equal(await page.evaluate(() => window.__sourceNative.saves.at(-1).text), 'second\n');
  await remoteEdit('fourth\n');
  await page.evaluate(() => {
    window.__sourceNative.holdSave = false;
    window.__sourceNative.releaseSave();
    window.__sourceNative.releaseSave = null;
  });
  await until(async () => {
    const s = await snapshot();
    return s.record.link.paperContent === 'fourth\n' && s.record.link.queued.length > 0;
  }, 'newer B revision was not retained after old source save');
  saved = await snapshot();
  assert.equal(saved.segment.text, 'fourth\n');
  assert(saved.record.plannedWrite);
  assert.equal(await page.evaluate(() => window.__sourceNative.text), 'second\n');
  await focus();
  await until(
    async () =>
      (await snapshot()).record.link.status === 'clean' &&
      (await page.evaluate(() => window.__sourceNative.text === 'fourth\n')),
    'planned source save recovery did not synchronize the newer revision',
  );
  assert.equal((await snapshot()).segment.text, 'fourth\n');
  console.log(
    'PASS: native pending is retried with its exact older payload before newer B edits; a concurrent fourth B revision also survives.',
  );

  const savesBefore = await page.evaluate(() => window.__sourceNative.saves.length);
  await page.evaluate(() => {
    window.__sourceNative.text = 'changed native\n';
    window.__sourceNative.sha256 = 'sha:changed';
  });
  await focus();
  await until(
    async () => !!(await snapshot()).record.pendingSource,
    'changed target source did not require manual identity confirmation',
  );
  assert.equal((await snapshot()).segment.text, 'fourth\n');
  assert.equal(await page.evaluate(() => window.__sourceNative.saves.length), savesBefore);
  await page.getByRole('button', { name: '运行状态', exact: true }).click();
  await page.getByRole('button', { name: '定位对应对象', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重新定位源对象', exact: true });
  await dialog.getByRole('button', { name: '确认这是对应对象', exact: true }).click();
  await until(
    async () => (await snapshot()).segment.text === 'changed native\n',
    'manual identity choice did not update paper',
  );
  console.log(
    'PASS: changed target at the same offset requires explicit object selection before paper update.',
  );

  const unknownBefore = await page.evaluate(() => window.__sourceNative.saves.length);
  await page.evaluate(() => {
    const state = window.__sourceNative;
    state.pending = {
      text: 'unknown native A\n',
      sha256: 'sha:unknown-a',
      baseSha256: state.sha256,
    };
  });
  await focus();
  await until(
    async () => !!(await snapshot()).record.pendingNative,
    'unknown native pending was not held for preview',
  );
  assert.equal(await page.evaluate(() => window.__sourceNative.saves.length), unknownBefore);
  assert.equal((await snapshot()).segment.text, 'changed native\n');
  await page.getByRole('button', { name: '预览原生待写回', exact: true }).click();
  let nativeDialog = page.getByRole('dialog', { name: '原生待写回版本', exact: true });
  await page.evaluate(() => {
    const state = window.__sourceNative;
    state.pending = {
      text: 'unknown native B\n',
      sha256: 'sha:unknown-b',
      baseSha256: state.sha256,
    };
  });
  await nativeDialog.getByRole('button', { name: '保留当前源文件', exact: true }).click();
  await until(
    () => page.getByRole('alert').filter({ hasText: 'pending-content-changed' }).count(),
    'pending CAS race was not rejected',
  );
  assert.equal(await page.evaluate(() => window.__sourceNative.pending.text), 'unknown native B\n');
  assert.equal(await page.evaluate(() => window.__sourceNative.text), 'changed native\n');
  await nativeDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await focus();
  await until(
    async () => (await snapshot()).record.pendingNative?.text === 'unknown native B\n',
    'changed native pending did not refresh its preview',
  );
  await page.getByRole('button', { name: '预览原生待写回', exact: true }).click();
  nativeDialog = page.getByRole('dialog', { name: '原生待写回版本', exact: true });
  await nativeDialog.getByRole('button', { name: '保留当前源文件', exact: true }).click();
  await until(
    async () =>
      !(await snapshot()).record.pendingNative && !!(await snapshot()).record.pendingSource,
    'explicit native resolution did not preserve source and enter manual object identity',
  );
  assert.equal(await page.evaluate(() => window.__sourceNative.pending), null);
  assert(
    await page.evaluate(() =>
      window.__sourceNative.archives.some((item) => item.text === 'unknown native B\n'),
    ),
  );
  await page.getByRole('button', { name: '定位对应对象', exact: true }).click();
  await page
    .getByRole('dialog', { name: '重新定位源对象', exact: true })
    .getByRole('button', { name: '确认这是对应对象', exact: true })
    .click();
  await until(
    async () => (await snapshot()).record.link.status === 'clean',
    'explicit native resolution object identity did not complete',
  );
  console.log(
    'PASS: unknown native pending never auto-writes; changed pending rejects stale CAS, explicit preview archives both and requires object identity confirmation.',
  );

  await page.evaluate(() => {
    window.__sourceNative.text = 'identity pending again\n';
    window.__sourceNative.sha256 = 'sha:pending-again';
  });
  await focus();
  await until(async () => {
    await focus();
    return !!(await snapshot()).record.pendingSource;
  }, 'second identity review did not begin');
  await page.evaluate(async (ids) => {
    const { readLocal, saveWorkspace } = await import('/src/storage.ts'),
      { NotebookEngine } = await import('/src/domain.ts');
    const stored = await readLocal('current'),
      e = new NotebookEngine(stored.project, 'timeout-config', 'tablet');
    const record = structuredClone(e.state.settings['source:' + ids.linkId]);
    record.link.offlineTimeoutMs = 50;
    e.setSetting('source:' + ids.linkId, record);
    await saveWorkspace({ ...stored, project: e.project });
    const channel = new BroadcastChannel('quiet-paper-changes');
    channel.postMessage({ projectId: e.project.id, epoch: stored.epoch });
    channel.close();
    window.__sourceNative.failRead = true;
  }, ids);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await focus();
  await until(
    async () => (await snapshot()).record.link.unavailableSince !== undefined,
    'identity review incorrectly paused source-access observations',
  );
  await new Promise((resolve) => setTimeout(resolve, 70));
  await focus();
  await until(
    async () => (await snapshot()).record.link.mode === 'frozen',
    'identity review incorrectly paused source offline freezing',
  );
  const frozen = await snapshot();
  assert.equal(frozen.segment.text, 'changed native\n');
  assert.equal(frozen.record.pendingSource.document.text, 'identity pending again\n');
  assert.equal(frozen.record.link.sourceSnapshot.text, 'changed native\n');
  console.log(
    'PASS: unresolved identity continues read-only access checks and freezes on source offline timeout while preserving both snapshots.',
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    'Source bridge browser acceptance: 7 checks passed (simulated bridge, real app and IndexedDB).',
  );
} finally {
  await context.close();
  await browser.close();
}
