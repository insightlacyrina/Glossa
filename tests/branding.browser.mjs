import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { NotebookEngine } from '../src/domain.ts';

// Focused rename acceptance only; intentionally does not run the existing suites.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const directory = await mkdtemp(join(tmpdir(), 'glossa-branding-'));
const token = 'glossa-local-branding-check-token';
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    GLOSSA_TOKEN: token,
    GLOSSA_DATA: directory,
    GLOSSA_STATIC: resolve('dist'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => {
  output += chunk;
});
server.stderr.on('data', (chunk) => {
  output += chunk;
});
const base = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/health')).ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal((await (await fetch(base + '/health')).json()).service, 'glossa-sync');
  assert.equal(
    (await fetch(base + '/api/status', { headers: { Authorization: 'Bearer ' + token } })).status,
    200,
  );
  assert.match(output, /Glossa sync listening/);
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(manifest.name, '笺注 · Glossa');
  assert.equal(manifest.short_name, '笺注');
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1060 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.brand').waitFor();
  assert.equal(await page.title(), '笺注 · Glossa');
  assert.match(await page.locator('.brand').innerText(), /笺注\s+Glossa/);
  assert.doesNotMatch(await page.locator('body').innerText(), /纸间|Quiet Paper|QUIET PAPER/);
  const input = page.locator('input[type=file][accept*=".glossa"]');
  assert.match(await input.getAttribute('accept'), /\.quietpaper/);
  await input.setInputFiles({
    name: '旧工程.quietpaper',
    mimeType: 'application/json',
    buffer: await readFile('examples/变化与积累.glossa'),
  });
  await page.locator('.note-topbar h1').filter({ hasText: '变化，与积累' }).waitFor();
  await page.getByText('已存于本机', { exact: true }).waitFor();
  await page.screenshot({ path: 'docs/workspace-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '导出与恢复', exact: true }).click();
  const projectDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '完整原生工程包', exact: true }).click();
  const project = await projectDownload;
  assert.match(project.suggestedFilename(), /\.glossa$/);
  const chunks = [];
  for await (const chunk of await project.createReadStream()) chunks.push(chunk);
  const imported = NotebookEngine.importProject(Buffer.concat(chunks).toString());
  assert.ok(imported.operations.length > 0);
  await page.getByRole('button', { name: '导出与恢复', exact: true }).click();
  const snapshotDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '离线阅读快照', exact: true }).click();
  const snapshot = await snapshotDownload;
  const htmlChunks = [];
  for await (const chunk of await snapshot.createReadStream()) htmlChunks.push(chunk);
  const html = Buffer.concat(htmlChunks).toString();
  assert.match(html, /笺注阅读快照/);
  assert.doesNotMatch(html, /纸间|Quiet Paper|QUIET PAPER/);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.representation-switch').first().getByRole('button').nth(2).click();
  await page.screenshot({ path: 'docs/workspace-split.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.representation-switch').first().getByRole('button').nth(1).click();
  await page.screenshot({ path: 'docs/workspace-mobile.png', fullPage: true });
  assert.doesNotMatch(await page.locator('body').innerText(), /纸间|Quiet Paper|QUIET PAPER/);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.locator('.note-topbar h1').filter({ hasText: '变化，与积累' }).waitFor();
  assert.equal(await page.title(), '笺注 · Glossa');
  assert.deepEqual(errors, []);
  console.log(
    'PASS 笺注 / Glossa: title, desktop/mobile identity, install manifest, service identity and GLOSSA_* configuration.',
  );
  console.log(
    'PASS legacy .quietpaper import, .glossa export round trip, renamed reading snapshot and offline reopen with retained local notes.',
  );
  console.log('Existing domain/sync/review/format/browser/instrumentation suites were not rerun.');
  await context.close();
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await once(server, 'exit');
  await rm(directory, { recursive: true, force: true });
}
