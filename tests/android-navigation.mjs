import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _android } from 'playwright';
import { NotebookEngine } from '../src/domain.ts';

// Only the named development AVD is accepted. Do not clear its existing data.
const serial = 'emulator-5556';
const out = resolve('artifacts/android-hig-20261023/navigation');
mkdirSync(out, { recursive: true });
const checks = [],
  errors = [];
const title = `Android-HIG-${randomUUID().slice(0, 8)}`;
function adb(...args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}
function pass(name, detail) {
  checks.push({ name, detail });
  console.log('PASS', name, detail ?? '');
}
async function until(check, message, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* The native activity can be switching. */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(message);
}
function nodes() {
  adb('shell', 'uiautomator dump /sdcard/glossa-hig-window.xml');
  return [
    ...adb('shell', 'cat /sdcard/glossa-hig-window.xml').matchAll(/<node\b([^>]+)\/?\s*>/g),
  ].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  );
}
function tap(node) {
  const b = node.bounds.match(/\d+/g).map(Number);
  adb('shell', `input tap ${Math.round((b[0] + b[2]) / 2)} ${Math.round((b[1] + b[3]) / 2)}`);
}
const back = () => adb('shell', 'input keyevent 4');
const ime = () => /mInputShown=true/.test(adb('shell', 'dumpsys input_method'));
const resumed = (pkg) =>
  adb('shell', 'dumpsys activity activities')
    .split('\n')
    .some((line) => /(?:topResumedActivity=|mResumedActivity:)/.test(line) && line.includes(pkg));
let device, page, ownId;
async function connect() {
  device ??= (await _android.devices({ omitDriverInstall: true })).find(
    (d) => d.serial() === serial,
  );
  assert.ok(device);
  const pid = await until(() => adb('shell', 'pidof local.quietpaper').split(' ')[0], 'App absent');
  const webview = await device.webView(
    { pkg: 'local.quietpaper', socketName: `webview_devtools_remote_${pid}` },
    { timeout: 20000 },
  );
  page = await webview.page();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.app-shell.platform-android').waitFor();
}
async function snapshot() {
  const project = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('quiet-paper-v1', 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('workspace', 'readonly'),
            get = tx.objectStore('workspace').get('current');
          get.onsuccess = () => resolve(get.result.project);
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  return new NotebookEngine(project).state;
}
async function screenshot(name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false, timeout: 5000 });
}
try {
  assert.match(adb('emu', 'avd', 'name'), /^Glossa_API35_ARM64/);
  adb('shell', 'am force-stop local.quietpaper');
  adb('shell', 'am start -n local.quietpaper/.MainActivity');
  await connect();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '偏好与同步' });
  await modal.waitFor();
  back();
  await modal.waitFor({ state: 'detached' });
  pass('system-back-closes-clean-modal');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const input = modal.locator('input[name=idle]');
  const original = await input.inputValue();
  const draft = original === '2.8' ? '3.1' : '2.8';
  await input.click();
  await input.fill(draft);
  await until(ime, 'Keyboard did not become visible');
  back();
  await until(() => !ime(), 'Back did not hide keyboard first');
  assert.equal(await input.inputValue(), draft);
  await screenshot('ime-back-keeps-form');
  pass('ime-back-precedes-application-back');
  back();
  const cancel = await until(
    () => nodes().find((n) => n['resource-id'] === 'android:id/button2'),
    'Unsaved-input native confirmation absent',
  );
  tap(cancel);
  assert.equal(await input.inputValue(), draft);
  pass('system-back-cancel-preserves-unsubmitted-input');
  // Returning to the actual initial value avoids a discard action in cleanup.
  await input.fill(original);
  if (ime()) {
    back();
    await until(() => !ime(), 'Keyboard did not close');
  }
  // Reset may differ on an old AVD; accept only this disposable form's discard prompt.
  back();
  if (await modal.isVisible()) {
    const ok = await until(
      () => nodes().find((n) => n['resource-id'] === 'android:id/button1'),
      'Cleanup confirmation absent',
    );
    tap(ok);
  }
  await modal.waitFor({ state: 'detached' });

  await page.locator('.new-paper').click();
  await page.locator('.paper-sheet').waitFor();
  await page.getByRole('button', { name: '笔记信息', exact: true }).click();
  const manage = page.getByRole('dialog', { name: '笔记信息' });
  await manage.getByLabel('标题', { exact: true }).fill(title);
  await manage.getByRole('button', { name: '保存', exact: true }).click();
  ownId = await until(
    async () => (await snapshot()).notes.find((note) => note.title === title)?.id,
    'Renamed test note was not durably saved',
  );
  const sheet = page.locator('.paper-sheet'),
    box = await sheet.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const common = { pointerType: 'pen', force: 0.65, tiltX: 12, tiltY: -7, button: 'left' };
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + Math.min(box.height * y, 160) });
  await cdp.send('Input.dispatchMouseEvent', {
    ...common,
    ...at(0.25, 0.15),
    type: 'mousePressed',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    ...common,
    ...at(0.35, 0.17),
    type: 'mouseMoved',
    buttons: 1,
  });
  // A real Android Back during the synthetic pen-down must retain this page.
  back();
  assert.equal(await page.locator('.app-shell').getAttribute('data-view'), 'paper');
  await cdp.send('Input.dispatchMouseEvent', {
    ...common,
    ...at(0.4, 0.18),
    type: 'mouseReleased',
    buttons: 0,
    force: 0,
  });
  await until(
    async () =>
      (await snapshot()).notes
        .find((n) => n.id === ownId)
        .pages[0].objects.some((o) => o.kind === 'stroke'),
    'Synthetic ink not saved',
  );
  await cdp.detach();
  pass('back-during-synthetic-pen-keeps-page-and-samples');

  await page.getByRole('button', { name: '插入', exact: true }).click();
  await page.getByRole('button', { name: '导入原生文件', exact: true }).click();
  await until(() => resumed('documentsui'), 'DocumentsUI absent');
  back();
  await until(() => resumed('local.quietpaper'), 'App did not resume');
  await page.locator('.paper-sheet').waitFor();
  pass('system-file-picker-back-cancels-without-leaving-note');
  back();
  await page.waitForFunction(
    () => document.querySelector('.app-shell')?.dataset.view === 'library',
  );
  await screenshot('paper-back-to-library');
  back();
  await until(() => !resumed('local.quietpaper'), 'Root Back did not leave Activity');
  await device.close();
  device = undefined;
  // Root Back can leave the old WebView target alive briefly in the same process.
  adb('shell', 'am force-stop local.quietpaper');
  adb('shell', 'am start -n local.quietpaper/.MainActivity');
  await connect();
  assert.ok(
    (await snapshot()).notes
      .find((n) => n.id === ownId)
      .pages[0].objects.some((o) => o.kind === 'stroke'),
  );
  pass('root-back-uses-platform-exit-and-reopen-retains-ink');
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(`${out}/result.json`, JSON.stringify({ title, ownId, checks, errors }, null, 2));
  if (device) await device.close();
}
