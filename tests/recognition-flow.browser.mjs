import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.addInitScript(() => {
  window.recognitionCalls = [];
  const reply = (id, result) =>
    setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent('quietpaper-native', {
            detail: { requestId: id, type: 'recognition', ok: true, ...result },
          }),
        ),
      20,
    );
  window.QuietPaperNative = {
    getRole: () => 'tablet',
    getDeviceId: () => 'recognition-browser-test',
    getPlatform: () => 'android',
    getRecognitionStatus: (id, language) =>
      reply(id, { downloaded: true, available: true, language }),
    recognizeInk: (id, json) => {
      const input = JSON.parse(json);
      window.recognitionCalls.push(input);
      reply(id, {
        text: 'x',
        candidates: [{ text: 'x' }, { text: 'X' }],
        engine: 'test-native-adapter',
      });
    },
    recognizeImage: (id) => reply(id, { text: '图片文字' }),
  };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
async function state() {
  return page.evaluate(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    return new NotebookEngine((await readLocal('current')).project).state;
  });
}
try {
  await page.goto(`${base}/tests/fixtures/workspace-harness.html`);
  await page.waitForFunction(() => window.workspaceHarness?.ready);
  const fixture = await page.evaluate(async () => {
    const { NotebookEngine } = await import('/src/domain.ts');
    const e = new NotebookEngine(undefined, 'fixture', 'tablet');
    const n = e.createNote('识别与反转写验收'),
      p = e.getNote(n).pages[0].id;
    const point = (x, y, time) => ({ x, y, time, pressure: 0.6, tiltX: 12, tiltY: -5 });
    const ids = [
      e.addStroke(n, p, [point(80, 100, 0), point(100, 120, 30), point(120, 140, 60)]),
      e.addStroke(n, p, [point(120, 100, 80), point(100, 120, 110), point(80, 140, 140)]),
    ];
    e.setSetting('idleMs', 20);
    await window.workspaceHarness.importProject(e.exportProject());
    return { n, p, ids };
  });
  await page.waitForFunction(() =>
    Object.entries(window.workspaceHarness.getEngine().state.settings).some(
      ([k, v]) => k.startsWith('candidate:') && v?.text === 'x',
    ),
  );
  const grouped = await page.evaluate(
    () =>
      Object.entries(window.workspaceHarness.getEngine().state.settings).find(
        ([k, v]) => k.startsWith('candidate:') && v?.text === 'x',
      )[1],
  );
  assert.deepEqual(grouped.sourceObjectIds, fixture.ids);
  assert.equal(grouped.mapping, 'unmapped');
  assert.equal((await state()).notes[0].blocks.length, 0);
  await page.goto(base);
  await page.locator('.nav-item').filter({ hasText: '校对' }).click();
  await page.locator('.proof-card').filter({ hasText: 'x' }).click();
  let dialog = page.getByRole('dialog', { name: '校对原始记录' });
  assert.equal(await dialog.locator('[data-ink-stroke]').count(), 2);
  await dialog.locator('input[type=checkbox]').check();
  await dialog.getByRole('button', { name: '确认对应', exact: true }).click();
  await page.waitForFunction(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    return (
      new NotebookEngine((await readLocal('current')).project).state.notes[0].blocks.length === 1
    );
  });
  let snapshot = await state();
  assert.deepEqual(snapshot.notes[0].blocks[0].segments[0].source.objectIds, fixture.ids);
  assert.equal(snapshot.notes[0].blocks[0].segments[0].source.precision, 'object');
  console.log(
    'PASS native adapter groups multiple strokes, leaves uncertain OCR unmapped, and real proofreading confirms all sources together.',
  );

  await page.locator('.recent-note').filter({ hasText: '识别与反转写验收' }).click();
  await page.locator('.representation-switch button').nth(0).click();
  await page.getByRole('button', { name: '框选与移动', exact: true }).click();
  const sheet = page.locator('.paper-sheet');
  await sheet.scrollIntoViewIfNeeded();
  const rect = await sheet.boundingBox();
  const width = snapshot.notes[0].pages[0].width,
    height = snapshot.notes[0].pages[0].height;
  await page.mouse.move(rect.x + (65 / width) * rect.width, rect.y + (85 / height) * rect.height);
  await page.mouse.down();
  await page.mouse.move(
    rect.x + (135 / width) * rect.width,
    rect.y + (155 / height) * rect.height,
    { steps: 5 },
  );
  await page.mouse.up();
  await page.getByRole('button', { name: '学习选中字形', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '学习选中字形' });
  await dialog.getByRole('textbox', { name: '字形对应字符' }).fill('X');
  await dialog.locator('input[type=checkbox]').check();
  await dialog.getByRole('button', { name: '保存字形', exact: true }).click();
  await page.locator('.representation-switch button').nth(2).click();
  await page.getByRole('button', { name: '修订文字', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑已有文字' });
  await editor.fill('X');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await page.waitForFunction(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    return (
      new NotebookEngine((await readLocal('current')).project).state.corrections.at(-1)?.mode ===
      'handwriting'
    );
  });
  snapshot = await state();
  const generated = snapshot.notes[0].pages[0].objects.filter((o) => o.revisionId && !o.deleted);
  assert.equal(generated.length, 2);
  assert.ok(generated.every((o) => o.kind === 'stroke' && o.points[0].pressure === 0.6));
  assert.equal(await page.locator('.paper-sheet [data-ink-stroke]').count(), 2);
  await page.reload();
  await page.locator('.paper-sheet [data-ink-stroke]').first().waitFor();
  assert.equal(await page.locator('.paper-sheet [data-ink-stroke]').count(), 2);
  assert.equal((await state()).handwritingGlyphs.length, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/private/tmp/glossa-recognition-flow.png', fullPage: true });
  console.log(
    'PASS real selection learns confirmed glyph; editing B creates editable pressure-preserving vector strokes that survive reload.',
  );
  await page.getByRole('button', { name: '局部橡皮', exact: true }).click();
  const inkRect = await page.locator('.paper-sheet').boundingBox();
  const centerX = inkRect.x + (100 / width) * inkRect.width;
  const centerY = inkRect.y + (120 / height) * inkRect.height;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    return (
      new NotebookEngine(
        (await readLocal('current')).project,
      ).state.notes[0].pages[0].objects.filter((o) => o.revisionId && !o.deleted).length === 4
    );
  });
  await page.getByRole('button', { name: '修订与历史', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '修订与历史' });
  await dialog.getByRole('button', { name: '独立撤销', exact: true }).click();
  await page.waitForFunction(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    return new NotebookEngine((await readLocal('current')).project).state.corrections.length === 0;
  });
  assert.equal(
    (await state()).notes[0].pages[0].objects.filter((o) => o.revisionId && !o.deleted).length,
    0,
  );
  assert.equal(await page.locator('.paper-sheet [data-ink-stroke]').count(), 2);
  console.log(
    'PASS real partial eraser preserves all split fragments in their revision; independent undo restores raw ink without leaked fragments.',
  );

  await page.goto(`${base}/tests/fixtures/workspace-harness.html`);
  await page.waitForFunction(() => window.workspaceHarness?.ready);
  await page.evaluate(async () => {
    const w = window.workspaceHarness;
    await w.retryRecognition();
    await w.waitForSave();
  });
  await page.waitForFunction(() =>
    Object.values(window.workspaceHarness.getEngine().state.settings).some(
      (c) => c?.text === 'x' && c?.segmentId,
    ),
  );
  assert.equal((await state()).notes[0].blocks[0].segments[0].text, 'x');
  console.log(
    'PASS explicit re-recognition of an already confirmed line offers a new candidate while preserving the existing B text.',
  );
  const appended = await page.evaluate(async ({ n, p }) => {
    const w = window.workspaceHarness;
    let id;
    w.transact((e) => {
      id = e.addStroke(n, p, [
        { x: 130, y: 105, pressure: 0.7, tiltX: 0, tiltY: 0, time: 160 },
        { x: 145, y: 140, pressure: 0.6, tiltX: 0, tiltY: 0, time: 220 },
      ]);
    });
    await w.flush();
    await w.waitForSave();
    return id;
  }, fixture);
  await page.waitForFunction(
    (id) =>
      Object.values(window.workspaceHarness.getEngine().state.settings).some((c) =>
        c?.sourceObjectIds?.includes(id),
      ),
    appended,
  );
  const updatedCandidate = await page.evaluate(
    (id) =>
      Object.values(window.workspaceHarness.getEngine().state.settings).find((c) =>
        c?.sourceObjectIds?.includes(id),
      ),
    appended,
  );
  assert.equal(updatedCandidate.sourceObjectIds.length, 3);
  assert.equal(updatedCandidate.segmentId, (await state()).notes[0].blocks[0].segments[0].id);
  await page.goto(base);
  await page.locator('.nav-item').filter({ hasText: '校对' }).click();
  await page.locator('.proof-card').filter({ hasText: 'x' }).click();
  dialog = page.getByRole('dialog', { name: '校对原始记录' });
  await dialog.locator('input[type=checkbox]').check();
  await dialog.getByRole('button', { name: '确认对应', exact: true }).click();
  await page.waitForFunction(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    return (
      new NotebookEngine((await readLocal('current')).project).state.notes[0].blocks[0].segments[0]
        .source.objectIds.length === 3
    );
  });
  assert.equal((await state()).notes[0].blocks.length, 1);
  console.log(
    'PASS appending to a confirmed line produces a versioned review candidate and updates the same B segment without duplicate blocks.',
  );

  await page.goto(`${base}/tests/fixtures/workspace-harness.html`);
  await page.waitForFunction(() => window.workspaceHarness?.ready);
  const scoped = await page.evaluate(async () => {
    const w = window.workspaceHarness;
    let ids, n, c;
    w.transact((e) => {
      n = e.createNote('多个段落边界');
      const p = e.getNote(n).pages[0].id;
      const pen = (x) => [
        { x, y: 200, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0 },
        { x: x + 20, y: 230, pressure: 0.5, tiltX: 0, tiltY: 0, time: 40 },
      ];
      ids = [e.addStroke(n, p, pen(80)), e.addStroke(n, p, pen(140))];
      for (const [index, id] of ids.entries()) {
        const b = e.createBlock(n, '已有段落', [id]);
        e.recognize(n, b, [id], String(index), { confirmed: true });
      }
      c = e.addStroke(n, p, pen(110));
    });
    await w.flush();
    await w.waitForSave();
    return { ids, n, c };
  });
  await page.waitForFunction(
    ({ c }) =>
      Object.values(window.workspaceHarness.getEngine().state.settings).some(
        (v) => v?.objectId === c,
      ),
    scoped,
  );
  const separate = await page.evaluate(
    ({ c }) =>
      Object.values(window.workspaceHarness.getEngine().state.settings).find(
        (v) => v?.objectId === c,
      ),
    scoped,
  );
  assert.deepEqual(separate.sourceObjectIds ?? [separate.objectId], [scoped.c]);
  assert.deepEqual(errors, []);
  console.log(
    'PASS new strokes between multiple confirmed B segments are recognized separately and cannot duplicate both existing segments.',
  );
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
