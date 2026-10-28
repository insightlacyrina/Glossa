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
  await page.waitForTimeout(4500);
  await page.screenshot({path: new URL('./after-extra-proof-candidate.png', import.meta.url).pathname});
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
  await page.waitForTimeout(4500);
  await page.screenshot({path: new URL('./after-extra-glyph.png', import.meta.url).pathname});
  await page.setViewportSize({width:360,height:640});
  await page.waitForTimeout(4500);
  await page.screenshot({path: new URL('./after-extra-glyph-narrow.png', import.meta.url).pathname});
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>window.QuietPaperNative.getRecognitionStatus=(id)=>setTimeout(()=>dispatchEvent(new CustomEvent('quietpaper-native',{detail:{requestId:id,type:'recognition',ok:false,error:'无法检查手写模型：网络暂时不可用，请稍后重试。'}})),20));
  await page.getByRole('button',{name:'导航',exact:true}).click();
  await page.locator('.sidebar').getByRole('button',{name:'设置',exact:true}).click();
  await page.locator('.settings-tabs').getByRole('button',{name:'识别与仿手写',exact:true}).click();
  await page.waitForTimeout(500);
  await page.screenshot({path: new URL('./after-extra-recognition-error.png', import.meta.url).pathname});
} finally { await browser.close(); await server.close(); }
