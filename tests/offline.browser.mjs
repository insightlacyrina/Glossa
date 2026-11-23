import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { seedWorkspace } from '../src/bootstrap.ts';

const port = Number(process.env.QP_OFFLINE_PORT ?? 4173);
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { stdio: 'pipe' },
);
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      acceptDownloads: true,
    }),
    page = await context.newPage();
  const errors = [],
    failed = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => failed.push({ url: r.url(), reason: r.failure()?.errorText }));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading', { name: '还没有笔记' }).waitFor();
  assert.equal(
    await page.locator('.new-paper').count(),
    0,
    'production browser must not gain tablet creation rights',
  );
  const example = seedWorkspace('offline-example').project;
  await page.evaluate(async (project) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('quiet-paper-v1', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('workspace', 'readwrite');
        const store = tx.objectStore('workspace'),
          read = store.get('current');
        read.onsuccess = () => store.put({ ...read.result, project }, 'current');
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    const reg = await navigator.serviceWorker.ready;
    while (reg.installing || reg.waiting) await new Promise((r) => setTimeout(r, 100));
  }, example);
  await page.reload();
  await page.locator('.note-topbar h1').filter({ hasText: '变化，与积累' }).waitFor();
  await page.locator('.representation-switch').first().getByRole('button').nth(1).click();
  const segment = page
    .locator('.structure-segment')
    .filter({ hasText: '导数描述一个瞬间' })
    .first();
  await segment.getByRole('button', { name: '修订文字', exact: true }).click();
  const input = page.getByRole('textbox', { name: '编辑已有文字' });
  await input.evaluate((el) => el.setSelectionRange(0, 0));
  await page.keyboard.insertText('离线保留：');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await page.getByText('已存于本机', { exact: true }).waitFor();
  // Installation must cache every build asset on first use, before any offline reload.
  await context.setOffline(true);
  await page.reload();
  await page.locator('.note-topbar h1').filter({ hasText: '变化，与积累' }).waitFor();
  await page.locator('.representation-switch').first().getByRole('button').nth(1).click();
  await page
    .locator('.structure-prose')
    .filter({ hasText: '离线保留：导数描述一个瞬间' })
    .waitFor();
  assert.equal(await page.locator('.new-paper').count(), 0);
  console.log(
    'PASS production reader retains existing B edits and loads the complete app after a first-install offline reload',
  );
  await page.getByRole('button', { name: '导出与恢复', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '离线阅读快照', exact: true }).click();
  const exported = await download.catch(async (error) => {
    console.log({
      errors,
      failed,
      body: (await page.locator('body').innerText()).slice(-3000),
      cache: await page.evaluate(async () => {
        const names = await caches.keys();
        return Promise.all(
          names.map(async (name) => ({
            name,
            keys: (await (await caches.open(name)).keys()).map((r) => r.url),
          })),
        );
      }),
    });
    throw error;
  });
  assert.match(exported.suggestedFilename(), /阅读\.html$/);
  assert.deepEqual(errors, []);
  console.log(
    'PASS offline dynamic export module is precached and production role cannot be widened by the viewport',
  );
  await context.close();
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
