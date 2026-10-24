import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

// Android styling and layered navigation, isolated from real device storage.
const out = resolve('artifacts/android-hig-20261023/browser');
await mkdir(out, { recursive: true });
const server = await createServer({
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const errors = [];
async function context(role, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  await ctx.addInitScript((role) => {
    window.QuietPaperNative = {
      getRole: () => role,
      getDeviceId: () => 'hig-browser-' + role,
      getPlatform: () => 'android',
    };
  }, role);
  const page = await ctx.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.app-shell.platform-android').waitFor();
  return { ctx, page };
}
async function state(page, view) {
  await page.waitForFunction(
    (view) => document.querySelector('.app-shell')?.dataset.view === view,
    view,
  );
}
async function confirmBack(page, accept) {
  page.once('dialog', (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
  assert.equal(await page.evaluate(() => window.glossaNavigateBack()), true);
}
try {
  const { ctx, page } = await context('tablet', { width: 1280, height: 900 });
  await page.locator('.paper-sheet').waitFor();
  await page.locator('.folder-item').filter({ hasText: '数学' }).click();
  await page.locator('.search-input').fill('积累');
  await page.locator('.note-card').first().click();
  await state(page, 'paper');
  assert.equal(await page.locator('.folder-item.active').getAttribute('aria-current'), 'page');
  assert.equal(await page.evaluate(() => window.glossaNavigateBack()), true);
  await state(page, 'library');
  assert.equal(await page.locator('.search-input').inputValue(), '积累');
  assert.match(await page.locator('.folder-item.active').innerText(), /数学/);
  console.log('PASS Android Back preserves folder and search context');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '偏好与同步' });
  await modal.locator('input[name=idle]').fill('2.8');
  await confirmBack(page, false);
  assert.equal(await modal.locator('input[name=idle]').inputValue(), '2.8');
  page.once('dialog', (dialog) => dialog.dismiss());
  await modal.getByRole('button', { name: 'Mac 同步', exact: true }).click();
  assert.equal(await modal.locator('input[name=idle]').inputValue(), '2.8');
  page.once('dialog', (dialog) => dialog.accept());
  await modal.getByRole('button', { name: 'Mac 同步', exact: true }).click();
  await modal.locator('input[name=url]').waitFor();
  assert.equal(await page.evaluate(() => window.glossaNavigateBack()), true);
  await modal.waitFor({ state: 'detached' });
  assert.equal(await page.locator('main').evaluate((el) => el.inert), false);
  console.log('PASS unsaved settings survive rejected Back and tab changes; clean modal closes');

  await page.locator('nav').getByRole('button', { name: /^温故/ }).click();
  await page
    .locator('.review-tabs')
    .getByRole('button', { name: /全部复习内容/ })
    .click();
  await page.locator('.self-rating').waitFor();
  const ratings = await page.locator('.self-rating button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const r = button.getBoundingClientRect();
      return { text: button.textContent.trim(), width: r.width, height: r.height };
    }),
  );
  assert.deepEqual(
    ratings.map((b) => b.text),
    ['未掌握', '已掌握'],
  );
  assert.equal(ratings[0].width, ratings[1].width);
  assert.equal(ratings[0].height, ratings[1].height);
  assert.ok(ratings[0].height >= 48);
  await page.screenshot({ path: resolve(out, 'tablet-review.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page
      .locator('.nav-item')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
    '0s',
  );
  console.log('PASS equal assessment targets and reduced-motion styles');
  await ctx.close();

  const phone = await context('phone', { width: 390, height: 844 });
  await phone.page
    .locator('input[type=file][accept=".glossa,.quietpaper,.json"]')
    .setInputFiles(resolve('examples/变化与积累.glossa'));
  await phone.page.getByRole('button', { name: '确认恢复', exact: true }).click();
  await phone.page.locator('.paper-sheet').waitFor();
  assert.equal(await phone.page.locator('.new-paper').count(), 0);
  assert.equal(await phone.page.locator('.writing-dock').count(), 0);
  assert.equal(await phone.page.locator('.sidebar').evaluate((el) => el.inert), true);
  await phone.page.getByRole('button', { name: '导航', exact: true }).click();
  await phone.page.getByRole('dialog', { name: '主导航' }).waitFor();
  assert.equal(await phone.page.locator('main').evaluate((el) => el.inert), true);
  await phone.page.keyboard.press('Escape');
  assert.equal(await phone.page.locator('.sidebar').evaluate((el) => el.inert), true);
  assert.equal(await phone.page.locator('main').evaluate((el) => el.inert), false);
  assert.equal(
    await phone.page
      .getByRole('button', { name: '导航', exact: true })
      .evaluate((el) => document.activeElement === el),
    true,
  );
  assert.ok(
    await phone.page
      .getByRole('button', { name: '返回笔记列表', exact: true })
      .evaluate((el) => el.getBoundingClientRect().width >= 48),
  );
  for (const width of [390, 320]) {
    await phone.page.setViewportSize({ width, height: 844 });
    assert.ok(
      await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    );
  }
  await phone.page.screenshot({ path: resolve(out, 'phone-reader.png') });
  console.log('PASS phone keeps read/light-edit permissions, drawer focus and 320px layout');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
