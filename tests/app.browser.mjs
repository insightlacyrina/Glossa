import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Real application acceptance. Chromium CDP pen events exercise the input path;
// physical stylus latency, palm rejection, and Android hardware still need device tests.
let base = process.env.QP_TEST_URL ?? process.env.QUIET_PAPER_TEST_URL ?? 'http://127.0.0.1:5173';
let appServer;
if (process.env.QP_TEST_SERVE === '1') {
  const { createServer } = await import('vite');
  appServer = await createServer({
    root: new URL('..', import.meta.url).pathname,
    configFile: false,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } },
  });
  await appServer.listen();
  base = `http://127.0.0.1:${appServer.httpServer.address().port}`;
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
context.on('page', (p) => p.on('pageerror', (error) => errors.push(error.message)));
page.on('pageerror', (error) => errors.push(error.message));
if (process.env.QP_TEST_DEBUG) {
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) console.log('NAVIGATION', frame.url());
  });
  page.on('console', (message) => console.log('BROWSER', message.type(), message.text()));
}
async function snapshot(target = page) {
  return target.evaluate(async () => {
    const { readLocal } = await import('/src/storage.ts');
    const { NotebookEngine } = await import('/src/domain.ts');
    const stored = await readLocal('current');
    if (!stored) return null;
    return { ...new NotebookEngine(stored.project).state, projectId: stored.project.id };
  });
}
async function until(check, message, timeout = 12000) {
  const start = Date.now();
  let value;
  while (Date.now() - start < timeout) {
    value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(message);
}
async function pen(
  target,
  fractions = [
    [0.2, 0.22],
    [0.24, 0.23],
    [0.28, 0.25],
    [0.32, 0.27],
  ],
) {
  const sheet = target.locator('.paper-sheet');
  await sheet.scrollIntoViewIfNeeded();
  const box = await sheet.boundingBox();
  assert.ok(box);
  const cdp = await context.newCDPSession(target);
  const coordinates = fractions.map(([x, y]) => ({
    x: box.x + box.width * x,
    y: box.y + box.height * y,
  }));
  const common = { pointerType: 'pen', force: 0.67, tiltX: 13, tiltY: -9 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...coordinates[0], ...common });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    ...coordinates[0],
    ...common,
  });
  for (const at of coordinates.slice(1))
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      buttons: 1,
      ...at,
      ...common,
    });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    ...coordinates.at(-1),
    ...common,
    force: 0,
  });
  await cdp.detach();
  return { box, coordinates };
}
const represent = async (target, side) =>
  target
    .locator('.representation-switch')
    .first()
    .getByRole('button')
    .nth(side === 'a' ? 0 : side === 'b' ? 1 : 2)
    .click();
const currentNote = async (id) => (await snapshot()).notes.find((note) => note.id === id);
const segments = (note) =>
  note.blocks.flatMap((block) => block.segments).filter((segment) => !segment.deleted);
const liveStrokes = (note) =>
  note.pages.flatMap((p) => p.objects).filter((o) => !o.deleted && o.kind === 'stroke');
const title = '验收 · 纸间';

try {
  await page.goto(base);
  await page.locator('.paper-sheet').waitFor();
  await page.locator('.new-paper').click();
  await until(
    async () => (await snapshot())?.notes.find((note) => note.title === '未命名笔记'),
    'new paper was not committed',
  );
  let note = (await snapshot()).notes.find((note) => note.title === '未命名笔记');
  const noteId = note.id;
  assert.equal(note.blocks.length, 0);
  assert.equal(note.pages.length, 1);
  await pen(page);
  await until(
    async () => liveStrokes(await currentNote(noteId)).length === 1,
    'pen stroke did not persist',
  );
  const initialStroke = liveStrokes(await currentNote(noteId))[0];
  assert.ok(initialStroke.points.length >= 3);
  assert.ok(
    initialStroke.points.some(
      (point) => Math.abs(point.pressure - 0.67) < 0.02 && point.tiltX === 13 && point.tiltY === -9,
    ),
  );
  await page.reload();
  await page.locator('.paper-sheet').waitFor();
  await page.locator('.recent-note').filter({ hasText: '未命名笔记' }).click();
  assert.deepEqual(liveStrokes(await currentNote(noteId))[0].points, initialStroke.points);
  console.log(
    'PASS blank paper accepts pen input before creating a knowledge block; pressure/tilt samples survive durable save and reload',
  );
  if (process.env.QP_TEST_DEBUG)
    console.log('CURRENT NOTE', await page.locator('.note-heading h1').innerText());

  await page.getByRole('button', { name: '归档', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '笔记归档' });
  await dialog.getByLabel('标题', { exact: true }).fill(title);
  await dialog.getByLabel('标签', { exact: true }).fill('验收标签，离线');
  if (process.env.QP_TEST_DEBUG) console.log('DIALOG', await dialog.innerText());
  const math = (await snapshot()).folders.find((folder) => folder.name === '数学');
  await dialog.locator('select[name="folder"]').selectOption(math.id);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await until(
    async () => (await currentNote(noteId)).title === title,
    'management changes not committed',
  );

  const original = '自然记录 x+x，完整保留过程。';
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.locator('.paper-sheet').click({ position: { x: 140, y: 240 } });
  dialog = page.getByRole('dialog', { name: '写入文字' });
  await dialog.getByRole('textbox', { name: '文字内容' }).fill(original);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await until(
    async () => segments(await currentNote(noteId)).find((segment) => segment.text === original),
    'idle pipeline did not faithfully create B from editable text',
  );
  await represent(page, 'b');
  const firstSegment = page.locator('.structure-segment-text').filter({ hasText: original });
  await firstSegment.getByRole('button', { name: '修订文字', exact: true }).click();
  let editor = page.getByRole('textbox', { name: '编辑已有文字' });
  await editor.evaluate((el) => el.setSelectionRange(0, 1));
  await page.keyboard.insertText('原');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  const revised = '原然记录 x+x，完整保留过程。';
  await until(
    async () => segments(await currentNote(noteId)).some((segment) => segment.text === revised),
    'B revision not committed',
  );
  await represent(page, 'a');
  await until(
    async () => await page.locator('.revision-text').filter({ hasText: revised }).count(),
    'B revision did not appear in editable A fallback layer',
  );
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await pen(page, [
    [0.22, 0.57],
    [0.28, 0.6],
    [0.35, 0.62],
  ]);
  await until(
    async () => liveStrokes(await currentNote(noteId)).length === 2,
    'later unrelated human stroke not committed',
  );
  const laterHuman = liveStrokes(await currentNote(noteId))[1];
  await page.getByRole('button', { name: '修订与历史', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '修订与历史' });
  await dialog.getByRole('button', { name: '独立撤销', exact: true }).click();
  await until(
    async () => segments(await currentNote(noteId)).some((segment) => segment.text === original),
    'independent revision undo did not restore B',
  );
  assert.ok(liveStrokes(await currentNote(noteId)).some((stroke) => stroke.id === laterHuman.id));
  assert.deepEqual(
    liveStrokes(await currentNote(noteId)).find((stroke) => stroke.id === initialStroke.id).points,
    initialStroke.points,
  );
  assert.deepEqual(
    liveStrokes(await currentNote(noteId)).find((stroke) => stroke.id === laterHuman.id).points,
    laterHuman.points,
  );
  assert.equal((await snapshot()).corrections.filter((c) => c.noteId === noteId).length, 0);
  console.log(
    'PASS idle text extraction → faithful B → concrete beforeinput edit → editable A revision; independent undo retains later human ink',
  );

  await represent(page, 'b');
  await page
    .locator('.structure-segment-text')
    .filter({ hasText: original })
    .getByRole('button', { name: '修订文字' })
    .click();
  editor = page.getByRole('textbox', { name: '编辑已有文字' });
  await editor.evaluate((el) => el.setSelectionRange(0, 1));
  await page.keyboard.insertText('原');
  await page.getByRole('button', { name: '保存修订' }).click();
  await until(
    async () => (await snapshot()).corrections.some((c) => c.noteId === noteId),
    'new revision missing',
  );
  const revisionId = (await snapshot()).corrections.find((c) => c.noteId === noteId).id;
  await page.getByRole('button', { name: '修订与历史', exact: true }).click();
  await page
    .getByRole('dialog', { name: '修订与历史' })
    .getByRole('button', { name: '合并到原稿' })
    .click();
  dialog = page.getByRole('dialog', { name: '合并此修订？' });
  assert.match(await dialog.innerText(), /不能再独立撤销/);
  await dialog.getByRole('button', { name: '确认不可逆合并' }).click();
  await until(
    async () => (await snapshot()).mergedRevisionIds.includes(revisionId),
    'explicit irreversible merge missing',
  );
  assert.ok(liveStrokes(await currentNote(noteId)).some((stroke) => stroke.id === laterHuman.id));
  assert.deepEqual(
    liveStrokes(await currentNote(noteId)).find((stroke) => stroke.id === initialStroke.id).points,
    initialStroke.points,
  );
  assert.deepEqual(
    liveStrokes(await currentNote(noteId)).find((stroke) => stroke.id === laterHuman.id).points,
    laterHuman.points,
  );
  console.log('PASS revision merge presents irreversible consequence and retains ordinary ink');

  await represent(page, 'a');
  await page.getByRole('button', { name: '添加纸张', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新纸张' });
  await dialog.locator('select[name="size"]').selectOption('B5');
  await dialog.locator('select[name="orientation"]').selectOption('landscape');
  await dialog.locator('select[name="template"]').selectOption('grid');
  await dialog.getByRole('button', { name: '添加纸张', exact: true }).click();
  await until(
    async () => (await currentNote(noteId)).pages.length === 2,
    'manual fixed paper addition failed',
  );
  note = await currentNote(noteId);
  const secondPage = note.pages[1];
  assert.equal(secondPage.size, 'B5');
  assert.equal(secondPage.template, 'grid');
  assert.ok(secondPage.width > secondPage.height);
  const gesture = await pen(page, [
    [0.25, 0.25],
    [0.3, 0.28],
    [0.35, 0.3],
  ]);
  await until(
    async () => (await currentNote(noteId)).pages[1].objects.some((o) => o.kind === 'stroke'),
    'second-page ink missing',
  );
  await page.getByRole('button', { name: '框选与移动', exact: true }).click();
  // Enclose the just-written object through the real selection tool.
  const box = await page.locator('.paper-sheet').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35, { steps: 4 });
  await page.mouse.up();
  await page.getByRole('button', { name: '校对选中内容', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '校对原始记录' });
  await dialog.getByRole('textbox', { name: '校对转录内容' }).fill('纸面图形的原意');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认对应', exact: true }).click();
  await until(
    async () =>
      segments(await currentNote(noteId)).some(
        (segment) =>
          segment.text === '纸面图形的原意' && segment.source.evidence === 'user-confirmed',
      ),
    'proofreading did not preserve confirmed exact-object evidence',
  );
  console.log(
    'PASS manual B5 landscape grid paper and selection → proofreading → explicit source confirmation',
  );

  await page.getByRole('button', { name: /^所有笔记/ }).click();
  await page.getByPlaceholder('搜索文字、公式与标签').fill('验收标签');
  assert.equal(await page.locator('.note-card:not(.new-note-card)').count(), 1);
  assert.match(await page.locator('.note-card:not(.new-note-card)').innerText(), /验收 · 纸间/);
  await page.getByPlaceholder('搜索文字、公式与标签').fill('');
  await page.locator('.folder-item').filter({ hasText: '数学' }).click();
  assert.ok(
    await page.locator('.note-card:not(.new-note-card)').filter({ hasText: title }).count(),
  );
  console.log('PASS existing-folder management, tags, library search, and folder browsing');

  await page.getByRole('button', { name: /^温故/ }).click();
  await page.getByRole('button', { name: /^全部知识块/ }).click();
  await page.locator('.review-list button').filter({ hasText: '已校对记录' }).click();
  const reviewBefore = Object.entries((await snapshot()).settings)
    .filter(([key]) => key.startsWith('review:'))
    .reduce((sum, [, card]) => sum + card.reviews, 0);
  await context.setOffline(true);
  await page.getByRole('button', { name: '会了', exact: true }).click();
  await until(
    async () =>
      Object.entries((await snapshot()).settings)
        .filter(([key]) => key.startsWith('review:'))
        .reduce((sum, [, card]) => sum + card.reviews, 0) > reviewBefore,
    'offline self-rating did not commit',
  );
  await page.getByRole('button', { name: '还不会', exact: true }).click();
  await until(
    async () =>
      Object.entries((await snapshot()).settings)
        .filter(([key]) => key.startsWith('review:'))
        .reduce((sum, [, card]) => sum + card.reviews, 0) >
      reviewBefore + 1,
    'second offline self-rating did not commit',
  );
  await context.setOffline(false);
  console.log(
    'PASS review queue and user-only know/do-not-know self assessment work with networking disabled',
  );

  for (const device of ['phone', 'mac']) {
    const client = await context.newPage();
    if (device === 'phone') await client.setViewportSize({ width: 390, height: 844 });
    await client.goto(`${base}/?device=${device}`);
    await client.locator('.paper-sheet').waitFor();
    assert.equal(await client.locator('.new-paper').count(), 0);
    assert.equal(await client.locator('.writing-dock').count(), 0);
    assert.equal(await client.getByRole('button', { name: '添加纸张', exact: true }).count(), 0);
    assert.equal(await client.getByRole('button', { name: '建立知识块', exact: true }).count(), 0);
    const beforeClient = await snapshot(client);
    await represent(client, 'b');
    await client.getByRole('button', { name: '修订文字', exact: true }).first().click();
    const clientEditor = client.getByRole('textbox', { name: '编辑已有文字' });
    const before = await clientEditor.inputValue();
    await clientEditor.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await client.keyboard.insertText('。');
    await client.getByRole('button', { name: '保存修订', exact: true }).click();
    await until(
      async () =>
        (await snapshot(client)).notes.some((note) =>
          segments(note).some((segment) => segment.text === before + '。'),
        ),
      `${device} existing B edit failed`,
    );
    const afterClient = await snapshot(client);
    assert.equal(afterClient.notes.length, beforeClient.notes.length);
    assert.equal(
      afterClient.notes.flatMap((note) => note.blocks).length,
      beforeClient.notes.flatMap((note) => note.blocks).length,
    );
    assert.deepEqual(
      afterClient.notes.flatMap(liveStrokes),
      beforeClient.notes.flatMap(liveStrokes),
    );
    const sizes = await client.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      sizes.scroll <= sizes.width + 1,
      `${device} horizontal page overflow ${sizes.scroll} > ${sizes.width}`,
    );
    await client.close();
    console.log(
      `PASS ${device} can edit existing B while note/block creation and A handwriting tools stay unavailable; viewport has no horizontal page overflow`,
    );
  }
  assert.deepEqual(errors, []);
  console.log('Application browser acceptance: 8 groups passed; no uncaught page errors.');
} catch (error) {
  await page
    .screenshot({ path: '/tmp/quiet-paper-app-failure.png', fullPage: true })
    .catch(() => {});
  console.error(
    'APP BODY AT FAILURE:',
    (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(-6000),
  );
  throw error;
} finally {
  await browser.close();
  await appServer?.close();
}
