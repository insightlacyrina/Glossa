import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

// Real app, browser Pointer Events, and IndexedDB. The Android bridge and pen hardware are simulated.
const server = await createServer({
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : '/usr/bin/chromium'),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 980 },
    hasTouch: true,
  });
  await context.addInitScript(() => {
    window.QuietPaperNative = {
      getRole: () => 'tablet',
      getDeviceId: () => 'stylus-browser-test',
      getPlatform: () => 'android',
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.new-paper').click();
  const sheet = page.locator('.paper-sheet');
  await sheet.waitFor();
  await sheet.evaluate((element) => {
    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'pen') element.dataset.testPenPointer = String(event.pointerId);
    });
  });
  const cdp = await context.newCDPSession(page);
  const preview = sheet.locator('path[data-ink-preview]');
  const hover = sheet.locator('circle[data-pen-hover]');
  const storedPaper = async ({ strokes, drafts } = {}) => {
    const handle = await page.waitForFunction(
      async ({ strokes, drafts }) => {
        const { readLocal, listDrafts } = await import('/src/storage.ts');
        const { NotebookEngine } = await import('/src/domain.ts');
        const current = await readLocal('current');
        const note =
          current &&
          new NotebookEngine(current.project).state.notes.find(
            (entry) => entry.title === '未命名笔记',
          );
        if (!note) return null;
        const live = note.pages[0].objects.filter(
          (object) => object.kind === 'stroke' && !object.deleted,
        );
        const checkpoints = await listDrafts();
        if (strokes !== undefined && live.length !== strokes) return null;
        if (drafts !== undefined && checkpoints.length !== drafts) return null;
        return { live, checkpoints };
      },
      { strokes, drafts },
      { timeout: 8000 },
    );
    try {
      return await handle.jsonValue();
    } finally {
      await handle.dispose();
    }
  };
  const paint = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const bounds = await sheet.boundingBox();
  assert.ok(bounds);
  const paperWidth = await sheet.evaluate((element) => element.viewBox.baseVal.width);
  const at = (x, y) => ({ x: bounds.x + x * bounds.width, y: bounds.y + y * bounds.height });
  const sendPen = (type, position, buttons = 0, button = 'none', force = 0) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      ...position,
      pointerType: 'pen',
      button,
      buttons,
      force,
      tiltX: 13,
      tiltY: -9,
      clickCount: button === 'none' ? 0 : 1,
    });
  const press = (position) => sendPen('mousePressed', position, 1, 'left', 0.12);
  const release = (position) => sendPen('mouseReleased', position, 0, 'left');
  const tap = async (position) => {
    await press(position);
    await release(position);
  };
  const waitHover = (tool) =>
    sheet
      .locator(`circle[data-pen-hover][data-tool=${tool}]`)
      .waitFor({ state: 'visible', timeout: 5000 });
  const start = at(0.15, 0.16);
  await storedPaper({ strokes: 0, drafts: 0 });
  await sendPen('mouseMoved', start);
  await waitHover('pen');
  assert.equal(await preview.getAttribute('d'), '');
  await storedPaper({ strokes: 0, drafts: 0 });

  await press(start);
  await storedPaper({ strokes: 0, drafts: 1 });
  const previewWrites = await sheet.evaluate(
    async (element, samples) => {
      const id = Number(element.dataset.testPenPointer);
      const input = (at, pressure, tiltX) =>
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: id,
          pointerType: 'pen',
          buttons: 1,
          clientX: at.x,
          clientY: at.y,
          pressure,
          tiltX,
          tiltY: -7,
        });
      let writes = 0;
      const observer = new MutationObserver((records) => (writes += records.length));
      observer.observe(element.querySelector('path[data-ink-preview]'), {
        attributes: true,
        attributeFilter: ['d'],
      });
      element.dispatchEvent(input(samples[0], 0.12, 19));
      const batch = [input(samples[1], 0.94, 23), input(samples[2], 0.94, 28)];
      const aggregated = input(samples[2], 0.94, 28);
      Object.defineProperty(aggregated, 'getCoalescedEvents', { value: () => batch });
      element.dispatchEvent(aggregated);
      // A second pointer has no authority over an in-progress pen gesture.
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: 'touch',
            pointerId: id + 100,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: 5,
            clientY: 5,
          }),
        );
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      observer.disconnect();
      return writes;
    },
    [at(0.23, 0.16), at(0.31, 0.16), at(0.39, 0.16)],
  );
  assert.equal(previewWrites, 1, 'same-frame pen movements should update the preview once');
  assert.equal(await sheet.locator('[data-ink-stroke]').count(), 0);
  const outline = await preview.getAttribute('d');
  assert.ok(outline, 'ink should still be previewed after an unrelated touch release');
  assert.ok(
    new Set(Array.from(outline.matchAll(/A([\d.]+),/g), (m) => m[1])).size > 1,
    'live path should reflect different pressure widths',
  );
  const end = at(0.48, 0.16);
  await release(end);
  const [line] = (await storedPaper({ strokes: 1, drafts: 0 })).live;
  assert.deepEqual(
    line.points.map((sample) => sample.tiltX),
    [13, 19, 23, 28, 13],
  );
  assert.deepEqual(
    line.points.slice(0, 4).map((sample) => Number(sample.pressure.toFixed(2))),
    [0.12, 0.12, 0.94, 0.94],
  );
  assert.ok(line.points.every((sample, i, points) => !i || sample.time >= points[i - 1].time));
  assert.ok(
    Math.abs(line.points.at(-1).x - 0.48 * paperWidth) < 1,
    'distinct pen-up endpoint was not saved',
  );
  console.log('PASS pressure preview, coalesced samples, terminal position, and pointer ownership');

  const canceled = at(0.19, 0.29);
  await press(canceled);
  await storedPaper({ strokes: 1, drafts: 1 });
  await sheet.evaluate(
    (element, position) => {
      const pointerId = Number(element.dataset.testPenPointer);
      // Queue a preview update before cancellation to check that no stale frame resurrects it.
      element.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'pen',
          pointerId,
          buttons: 1,
          clientX: position.x,
          clientY: position.y,
          pressure: 0.65,
        }),
      );
      element.dispatchEvent(
        new PointerEvent('pointercancel', { bubbles: true, pointerType: 'pen', pointerId }),
      );
    },
    at(0.26, 0.3),
  );
  await release(canceled);
  await storedPaper({ strokes: 1, drafts: 0 });
  await paint();
  assert.equal(await preview.getAttribute('d'), '');

  await press(canceled);
  await sendPen('mouseMoved', at(0.24, 0.3), 1, 'none', 0.7);
  await storedPaper({ strokes: 1, drafts: 1 });
  await sheet.evaluate((element) => {
    const pointerId = Number(element.dataset.testPenPointer);
    if (!element.hasPointerCapture(pointerId))
      throw new Error('active pen did not capture its pointer');
    element.releasePointerCapture(pointerId);
  });
  await sendPen('mouseMoved', at(0.3, 0.3), 1, 'none', 0.7);
  await release(at(0.3, 0.3));
  await storedPaper({ strokes: 1, drafts: 0 });
  await paint();
  assert.equal(await preview.getAttribute('d'), '');
  console.log('PASS cancel and lost capture discard live previews and consume checkpoints');

  const dotA = at(0.54, 0.29),
    dotB = at(0.67, 0.29);
  await tap(dotA);
  await tap(dotB);
  const { live: targets } = await storedPaper({ strokes: 3, drafts: 0 });
  const [, markA, markB] = targets;
  const barrelDown = (position) => sendPen('mousePressed', position, 2, 'right');
  const barrelUp = (position) => sendPen('mouseReleased', position, 0, 'right');
  await sendPen('mouseMoved', dotA);
  await barrelDown(dotA);
  await waitHover('eraser');
  await sendPen('mouseMoved', dotB, 2);
  assert.equal(await preview.getAttribute('d'), '');
  await barrelUp(dotB);
  await waitHover('pen');
  assert.equal(await sheet.locator('[data-ink-stroke]').count(), 3);
  await storedPaper({ strokes: 3, drafts: 0 });

  // Chording produces tip-down and tip-up as pointermove while the barrel button stays held.
  await barrelDown(dotA);
  await sendPen('mousePressed', dotA, 3, 'left', 0.45);
  await sendPen('mouseMoved', { x: dotA.x + 2, y: dotA.y }, 3, 'none', 0.6);
  await sendPen('mouseReleased', dotA, 2, 'left');
  assert.deepEqual(
    (await storedPaper({ strokes: 2, drafts: 0 })).live.map((item) => item.id),
    [line.id, markB.id],
  );
  await sendPen('mouseMoved', dotB, 2);
  await barrelUp(dotB);
  await waitHover('pen');
  assert.equal(await sheet.locator(`[data-ink-stroke="${markA.id}"]`).count(), 0);
  assert.equal(
    await page.getByRole('button', { name: '钢笔', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await page.getByRole('button', { name: '局部橡皮', exact: true }).click();
  await tap(dotB);
  assert.equal((await storedPaper({ strokes: 1, drafts: 0 })).live[0].id, line.id);
  console.log('PASS hover-only barrel gesture is harmless and tip contact erases temporarily');

  await sendPen('mouseMoved', { x: 20, y: 20 });
  await hover.waitFor({ state: 'hidden', timeout: 5000 });
  const scrollBefore = await page.evaluate(() => scrollY);
  const finger = at(0.78, 0.36);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...finger, id: 1 }],
  });
  for (const distance of [20, 55, 110]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: finger.x, y: finger.y - distance, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction((startY) => scrollY > startY + 30, scrollBefore, { timeout: 5000 });
  assert.deepEqual((await storedPaper({ strokes: 1, drafts: 0 })).live[0].points, line.points);
  console.log('PASS a finger pans the paper once the pen leaves without changing the ink');

  await page.reload();
  const reloaded = await storedPaper({ strokes: 1, drafts: 0 });
  assert.deepEqual(reloaded.live[0].points, line.points);
  console.log('PASS stroke samples persist without stale recovery entries after reload');

  const settings = page.getByRole('button', { name: '设置', exact: true });
  const dialog = page.getByRole('dialog', { name: '偏好与同步' });
  const sideKey = dialog.locator('input[name=stylus-barrel-eraser]');
  const cursor = dialog.locator('input[name=stylus-hover-cursor]');
  await settings.click();
  assert.equal(await sideKey.isChecked(), true);
  assert.equal(await cursor.isChecked(), true);
  await sideKey.uncheck();
  await cursor.uncheck();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.reload();
  await settings.click();
  assert.equal(await sideKey.isChecked(), false);
  assert.equal(await cursor.isChecked(), false);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.recent-note').filter({ hasText: '未命名笔记' }).click();
  const paper = await sheet.boundingBox();
  assert.ok(paper);
  const overLine = { x: paper.x + paper.width * 0.31, y: paper.y + paper.height * 0.16 };
  await sendPen('mouseMoved', overLine);
  await paint();
  assert.equal(await hover.getAttribute('visibility'), 'hidden');
  await barrelDown(overLine);
  await sendPen('mousePressed', overLine, 3, 'left', 0.45);
  await sendPen('mouseReleased', overLine, 2, 'left');
  await barrelUp(overLine);
  assert.deepEqual((await storedPaper({ strokes: 2, drafts: 0 })).live[0].points, line.points);
  assert.deepEqual(errors, []);
  console.log(
    'PASS local stylus preferences survive reload and disable their respective behaviors',
  );
} finally {
  await browser?.close();
  await server.close();
}
