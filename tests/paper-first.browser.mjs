import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const out = resolve(process.env.GLOSSA_PAPER_FIRST_OUTPUT ?? 'artifacts/paper-first');
await mkdir(out, { recursive: true });
const server = process.env.QP_TEST_URL
  ? undefined
  : await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server?.listen();
const base = process.env.QP_TEST_URL ?? 'http://127.0.0.1:' + server.httpServer.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
const example = await readFile('examples/变化与积累.glossa');
const errors = [];

async function open(role, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: role === 'phone' });
  await ctx.addInitScript((role) => {
    window.QuietPaperNative = {
      getRole: () => role,
      getDeviceId: () => 'paper-first-browser-' + role,
      getPlatform: () => 'android',
    };
  }, role);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator('.app-shell').waitFor();
  return { page, ctx };
}
const button = (context, name) => context.getByRole('button', { name, exact: true });
const mode = (page, name) =>
  button(page.getByRole('group', { name: '阅读方式', exact: true }), name);
const projectFile = (page) => page.locator('input[type=file][accept*=".glossa"]');
const exampleFile = {
  name: '变化与积累.glossa',
  mimeType: 'application/json',
  buffer: example,
};
const zoom = (page, value) =>
  page.getByRole('group', { name: '原稿缩放' }).getByText(value, { exact: true }).waitFor();
async function inlineSource(page) {
  await mode(page, '对照').click();
  assert.equal(await page.locator('.paper-sheet').count(), 0);
  const id = await page
    .locator('.structure-segment')
    .filter({ has: button(page, '看原稿') })
    .first()
    .getAttribute('id');
  const segment = page.locator('#' + id);
  const body = segment.locator('.structure-segment-content');
  await body.scrollIntoViewIfNeeded();
  const before = await body.boundingBox();
  await body.tap();
  const crop = segment.locator('.structure-inline-source .paper-preview').first();
  await crop.waitFor();
  const after = await body.boundingBox();
  assert.ok(Math.abs(before.y - after.y) <= 2, 'expansion should keep this paragraph in place');
  assert.ok(
    (await crop.getAttribute('viewBox')).split(' ').some((value, i) => i < 2 && +value !== 0),
  );
  assert.equal(await button(segment, '收起原稿').getAttribute('aria-expanded'), 'true');
  return segment;
}

try {
  const { page: phone, ctx: phoneContext } = await open('phone', { width: 390, height: 844 });
  await button(phone, '导入工程').waitFor();
  await projectFile(phone).setInputFiles(exampleFile);
  await phone.locator('.paper-sheet').waitFor();
  assert.equal(await phone.getByRole('dialog').count(), 0);
  const fitted = await phone.locator('.paper-sheet').boundingBox();
  assert.ok(fitted.y + fitted.height <= 844, 'the whole example sheet fits on opening');
  await phone.screenshot({ path: resolve(out, 'phone-fit.png') });

  const cdp = await phoneContext.newCDPSession(phone);
  const x = Math.round(fitted.x + fitted.width * 0.59),
    y = Math.round(fitted.y + fitted.height * 0.33);
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await zoom(phone, '250%');
  const viewport = phone.locator('.reading-viewport');
  const originalOffset = await viewport.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  assert.ok(originalOffset.x > 0 && originalOffset.y > 0);
  const zoomedBox = await viewport.boundingBox();
  const dragX = Math.round(zoomedBox.x + zoomedBox.width * 0.7);
  const dragY = Math.round(zoomedBox.y + zoomedBox.height * 0.58);
  // Verify each axis separately. Chromium may lock a diagonal touch drag to one axis.
  for (const [xDistance, yDistance] of [
    [-100, 0],
    [0, -100],
  ]) {
    await cdp.send('Input.synthesizeScrollGesture', {
      x: dragX,
      y: dragY,
      xDistance,
      yDistance,
      gestureSourceType: 'touch',
      preventFling: true,
    });
  }
  await phone.waitForFunction(({ x, y }) => {
    const el = document.querySelector('.reading-viewport');
    return el.scrollLeft > x + 30 && el.scrollTop > y + 20;
  }, originalOffset);
  await phone.screenshot({ path: resolve(out, 'phone-zoom.png') });
  await button(phone, '适合宽度').click();
  await zoom(phone, '100%');
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: x - 38, y, id: 1 },
      { x: x + 38, y, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: x - 76, y, id: 1 },
      { x: x + 76, y, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await zoom(phone, '200%');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log(
    'PASS phone fit, double-tap, two-axis touch pan, anchored pinch, and no outer overflow',
  );

  const phoneSegment = await inlineSource(phone);
  await phone.screenshot({ path: resolve(out, 'phone-compare.png') });
  await button(phoneSegment, '查看整页').first().click();
  await phone.locator('.paper-sheet').waitFor();
  assert.equal(await mode(phone, '原稿').getAttribute('aria-pressed'), 'true');
  await phoneContext.close();
  console.log('PASS phone comparison preserves the paragraph and opens the verified source page');

  const { page, ctx } = await open('tablet', { width: 1280, height: 800 });
  await page.locator('.paper-sheet').waitFor();
  const sheet = await page.locator('.paper-sheet').boundingBox();
  const dock = await page.locator('.writing-dock').boundingBox();
  await page.screenshot({ path: resolve(out, 'tablet-landscape-paper.png') });
  assert.ok(
    sheet.y < 165 && dock.y + dock.height < sheet.y,
    `tools should not cover the sheet: ${JSON.stringify({ sheet, dock })}`,
  );
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForFunction(() => window.scrollY > 200);
  assert.ok(
    (await page.locator('.writing-dock').boundingBox()).y >= 0,
    'writing tools remain reachable when scrolling',
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await button(page, '钢笔').click();
  const pen = page.getByRole('dialog', { name: '钢笔设置' });
  await pen.getByLabel('笔宽').selectOption('4.5');
  await button(pen, '应用').click();
  await button(page, '钢笔').click();
  assert.equal(await pen.getByLabel('笔宽').inputValue(), '4.5');
  await button(pen, '关闭').click();
  await button(page, '插入').click();
  const insert = page.getByRole('dialog', { name: '插入到原稿' });
  for (const label of ['文字', '公式', '插入图片', '导入原生文件'])
    await button(insert, label).waitFor();
  await button(insert, '关闭').click();

  await mode(page, '对照').click();
  await page.locator('.structure-segment').first().waitFor();
  const paperX = (await page.locator('.paper-region').boundingBox()).x;
  assert.ok((await page.locator('.structure-region').boundingBox()).x > paperX);
  await page.screenshot({
    path: resolve(out, 'tablet-landscape-compare.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 800, height: 1100 });
  await mode(page, '原稿').click();
  const portraitSegment = await inlineSource(page);
  assert.ok((await portraitSegment.boundingBox()).y < 500);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(out, 'tablet-portrait-compare.png') });
  console.log(
    'PASS tablet landscape comparison, compact unoccluded writing tools and portrait inline source',
  );

  await page.locator('.folder-item').filter({ hasText: '灵感' }).click();
  await page.getByRole('heading', { name: '这个文件夹还没有笔记' }).waitFor();
  await button(page, '在灵感中新建笔记').click();
  await button(page, '笔记信息').click();
  const info = page.getByRole('dialog', { name: '笔记信息' });
  assert.equal(await info.locator('select option:checked').textContent(), '灵感');
  await info.getByLabel('标题').fill('灵感中的笔记');
  await button(info, '保存').click();
  await button(page, '添加一页').click();
  await button(page.getByRole('dialog', { name: '添加一页' }), '添加一页').click();
  await button(page, '第 2 页').waitFor();
  assert.equal(await button(page, '第 2 页').getAttribute('aria-current'), 'page');
  await button(page, '返回笔记列表').click();
  assert.equal(await page.locator('.note-card').count(), 1);
  await page.locator('.note-card').click();
  assert.equal(await button(page, '第 2 页').getAttribute('aria-current'), 'page');
  assert.equal(await page.getByText('THE THINGS WE KEEP').count(), 0);
  await page.reload();
  await page.locator('.recent-note').filter({ hasText: '灵感中的笔记' }).click();
  assert.equal(await button(page, '第 2 页').getAttribute('aria-current'), 'page');
  console.log(
    'PASS folder-aware creation, distinct add-page action, and restored page after reload',
  );

  await projectFile(page).setInputFiles(exampleFile);
  const replacement = page.getByRole('dialog', { name: '用此工程替换当前工作区' });
  await replacement.getByText(/原工作区会保存在本机恢复副本中/).waitFor();
  await button(replacement, '关闭').click();
  await page.getByRole('heading', { name: '灵感中的笔记' }).waitFor();
  await projectFile(page).setInputFiles(exampleFile);
  await button(replacement, '替换并导入').click();
  await page.getByRole('heading', { name: '变化，与积累' }).waitFor();
  await page.getByText('工程已导入', { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(async () => {
      const { listRecoveries } = await import('/src/storage.ts');
      const { NotebookEngine } = await import('/src/domain.ts');
      return (await listRecoveries()).some(({ recovery }) =>
        new NotebookEngine(recovery.workspace.project).state.notes.some(
          (note) => note.title === '灵感中的笔记',
        ),
      );
    }),
  );
  console.log(
    'PASS active workspace replacement confirms, cancellation preserves data, and the recovery copy contains the original note',
  );
  await ctx.close();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server?.close();
}
