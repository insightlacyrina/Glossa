import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { _android } from 'playwright';
import { NotebookEngine } from '../src/domain.ts';
import { verifyProjectPackage } from './android-project-package.mjs';

// Run against the *packaged application* in a dedicated Android test AVD.
// Only UI/real pointer events mutate the project. IndexedDB reads and host-side replay
// below are observations, never seeds. Test-only provider controls modify owned sources.
// node --import tsx tests/android-product.mjs
const serial = process.env.ANDROID_SERIAL || 'emulator-5556';
const out = resolve(process.env.GLOSSA_PRODUCT_EVIDENCE || 'artifacts/local-migration/product');
mkdirSync(out, { recursive: true });
const runId = randomUUID();
let noteTitle = `Glossa-product-${runId.slice(0, 8)}`;
const resumePath = process.env.GLOSSA_PRODUCT_RESUME;
const previousRun = resumePath ? JSON.parse(readFileSync(resumePath, 'utf8')) : null;
const checks = [],
  errors = [];
let device, page, cdp, noteId;
function adb(...args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}
const shellQuote = (v) => "'" + String(v).replaceAll("'", "'\\''") + "'";
function control(method, id, extra = {}) {
  if (typeof extra.text === 'string') {
    extra = { ...extra, base64: Buffer.from(extra.text, 'utf8').toString('base64') };
    delete extra.text;
  }
  const cmd = [
    'content',
    'call',
    '--uri',
    'content://local.quietpaper.test.safcontrol',
    '--method',
    method,
    '--arg',
    id,
  ];
  for (const [key, value] of Object.entries(extra))
    cmd.push('--extra', `${key}:${typeof value === 'boolean' ? 'b' : 's'}:${value}`);
  const process = spawnSync('adb', ['-s', serial, 'shell', cmd.map(shellQuote).join(' ')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const result = (process.stdout || '') + (process.stderr || '');
  if (process.status || /Exception|Error while|\[ERROR\]|usage: adb/.test(result))
    throw new Error(result);
  return result;
}
function assertSourceBytes(id, expected) {
  const result = control('bytes', id);
  const length = result.match(/(?:^|[,\s{])length=(\d+)/)?.[1];
  const sha = result.match(/sha256=([a-f0-9]{64})/)?.[1];
  assert.equal(Number(length), Buffer.byteLength(expected, 'utf8'));
  assert.equal(sha, createHash('sha256').update(expected, 'utf8').digest('hex'));
}
function pass(name, detail) {
  checks.push({ name, detail });
  console.log('PASS', name, detail || '');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(message + (last ? `: ${last}` : ''));
}
async function connect() {
  if (!device)
    device = (await _android.devices({ omitDriverInstall: true })).find(
      (d) => d.serial() === serial,
    );
  assert.ok(device, `Android device ${serial} absent`);
  const pid = await until(
    () => adb('shell', 'pidof local.quietpaper').split(' ')[0],
    'App PID absent',
  );
  const webview = await device.webView(
    { pkg: 'local.quietpaper', socketName: `webview_devtools_remote_${pid}` },
    { timeout: 20000 },
  );
  page = await webview.page();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.app-shell').waitFor();
  assert.equal(await page.evaluate(() => window.QuietPaperNative.getRole()), 'tablet');
  cdp = await page.context().newCDPSession(page);
}
async function raw() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('quiet-paper-v1', 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('workspace', 'readonly');
          const result = {},
            cursor = tx.objectStore('workspace').openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (c) {
              result[String(c.key)] = c.value;
              c.continue();
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
}
async function state() {
  return new NotebookEngine((await raw()).current.project).state;
}
async function ownNote() {
  return (await state()).notes.find((n) => n.id === noteId);
}
async function ownSource(name) {
  return Object.values((await state()).settings).find(
    (v) => v?.document?.name === name && v.noteId === noteId,
  );
}
async function screenshot(name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false, timeout: 5000 });
}
async function navAction(locator) {
  if (!(await locator.isVisible()))
    await page.getByRole('button', { name: '导航', exact: true }).click();
  await locator.click();
}
async function openNote() {
  await navAction(page.locator('.recent-note').filter({ hasText: noteTitle }));
  await represent('a');
  await page.locator('.paper-sheet').waitFor();
}
async function activity() {
  await navAction(page.getByRole('button', { name: '运行状态', exact: true }));
}
async function represent(side) {
  await page
    .locator('.representation-switch')
    .first()
    .getByRole('button')
    .nth(side === 'a' ? 0 : side === 'b' ? 1 : 2)
    .click();
}
function nodesFromXml(xml) {
  return [...xml.matchAll(/<node\b([^>]+)\/?\s*>/g)].map((m) =>
    Object.fromEntries(
      [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [
        a[1],
        a[2].replaceAll('&amp;', '&').replaceAll('&quot;', '"'),
      ]),
    ),
  );
}
function nativeNodes() {
  adb('shell', 'uiautomator dump /sdcard/glossa-product-window.xml');
  return nodesFromXml(adb('shell', 'cat /sdcard/glossa-product-window.xml'));
}
function tap(node) {
  const b = node.bounds.match(/\d+/g).map(Number);
  adb('shell', `input tap ${Math.round((b[0] + b[2]) / 2)} ${Math.round((b[1] + b[3]) / 2)}`);
}
async function selectSource(name) {
  // This only navigates the genuine DocumentsUI. No onActivityResult injection.
  let nodes = await until(
    () => {
      const n = nativeNodes();
      return n.some((x) => /documentsui/.test(x.package || '')) && n;
    },
    'System DocumentsUI did not open',
    15000,
  );
  let item = nodes.find((n) => n.text === name || n['content-desc'] === name);
  if (!item) {
    let root;
    {
      const menu = nodes.find((n) =>
        /Show roots|显示根目录|打开导航抽屉|Open navigation drawer/.test(n['content-desc'] || ''),
      );
      if (menu) {
        tap(menu);
        await sleep(250);
        nodes = nativeNodes();
      }
      root =
        nodes.find(
          (n) => n.text === 'Glossa test files' && /android:id\/title/.test(n['resource-id'] || ''),
        ) || nodes.find((n) => n.text === 'Glossa test files');
    }
    assert.ok(root, 'Test DocumentsProvider must be visible in real system navigation drawer');
    tap(root);
    await sleep(200);
    nodes = await until(
      () => {
        const values = nativeNodes();
        return values.some((n) => n.text === name) && values;
      },
      `Owned fixture ${name} missing after root query`,
      10000,
    );
    item = nodes.find((n) => n.text === name);
  }
  assert.ok(item, `Owned fixture ${name} missing from real DocumentsUI`);
  tap(item);
}
async function createNote() {
  const previous = new Set((await state()).notes.map((n) => n.id));
  await navAction(page.locator('.new-paper'));
  await page.locator('.paper-sheet').waitFor();
  noteId = await until(
    async () => (await state()).notes.find((n) => !previous.has(n.id))?.id,
    'New paper not persisted',
  );
  await page.getByRole('button', { name: '笔记信息', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '笔记信息' });
  await dialog.getByLabel('标题', { exact: true }).fill(noteTitle);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await until(async () => (await ownNote())?.title === noteTitle, 'Note title not saved');
}
async function editB(previous, next) {
  await represent('b');
  const segment = page.locator('.structure-segment').filter({ hasText: previous }).first();
  await until(
    async () => await segment.count(),
    'Idle extraction did not create editable B segment',
    25000,
  );
  const edit = segment.getByRole('button', { name: /修订文字|修订公式/ });
  await edit.click();
  const editor = page.getByRole('textbox', { name: /编辑已有文字|编辑已有公式/ });
  const oldText = await editor.inputValue();
  const start = oldText.indexOf(previous);
  assert.ok(start >= 0);
  await editor.evaluate(
    (el, range) => el.setSelectionRange(...range),
    [start, start + previous.length],
  );
  await page.keyboard.insertText(next);
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await until(
    async () =>
      (await ownNote()).blocks.some((b) =>
        b.segments.some((s) => !s.deleted && s.text.includes(next)),
      ),
    'B revision not persisted',
  );
}
async function checkSource(name) {
  await activity();
  const status = page.locator('.source-status').filter({ hasText: name });
  await status.getByRole('button', { name: '检查源文件', exact: true }).click();
  return status;
}
async function importFixture(kind) {
  const id = randomUUID(),
    name = `Glossa-product-${id}.${kind}`;
  const line = kind === 'md' ? 'Product markdown x+1' : '$$x+1$$';
  const before =
    kind === 'md'
      ? `\uFEFF---\r\ntitle: ${id}\r\n---\r\n\r\n${line}\r\n<!-- preserve ${id} -->\r\n`
      : `\\documentclass{article}\r\n% preserve ${id}\r\n\\begin{document}\r\n${line}\r\n\\end{document}\r\n`;
  control('create', id, { text: before, name });
  await openNote();
  await represent('a');
  await page.getByRole('button', { name: '插入', exact: true }).click();
  await page.getByRole('button', { name: '导入原生文件', exact: true }).click();
  await selectSource(name);
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog
    .locator('.source-object')
    .filter({ hasText: line })
    .getByRole('button', { name: '插入并关联', exact: true })
    .click();
  const source = await until(() => ownSource(name), `Imported ${kind} source not persisted`);
  assert.ok(source.uri.startsWith('content://local.quietpaper.test.documents/'));
  await editB('x+1', 'x+2');
  await checkSource(name);
  await until(
    async () => {
      const s = await ownSource(name);
      return s?.link.status === 'clean' && s.document.text === before.replace('x+1', 'x+2');
    },
    `${kind}: changed B was not written to source`,
    25000,
  );
  // Independent provider observation, no direct NativeSourceStore invocation.
  assertSourceBytes(id, before.replace('x+1', 'x+2'));
  const after = await ownSource(name);
  assert.equal(after.document.text, before.replace('x+1', 'x+2'));
  writeFileSync(`${out}/${kind}-expected-source.txt`, before.replace('x+1', 'x+2'));
  await screenshot(`${kind}-source-written`);
  pass(
    `${kind}: system SAF import → real object insertion → idle B → selected B edit → real source write/reopen`,
    { name, uri: source.uri },
  );
  return { id, name, before, written: before.replace('x+1', 'x+2') };
}
async function sourceFaults(fixture) {
  const { id, name, written } = fixture;
  control('offline', id, { offline: true });
  await openNote();
  await editB('x+2', 'x+3');
  await checkSource(name);
  const unavailable = await until(async () => {
    const s = await ownSource(name);
    return s?.link.status === 'unavailable' && s.link.queued.length && s;
  }, 'Unavailable source did not retain queued B intent');
  assert.ok(unavailable.link.paperContent.includes('x+3'));
  assert.ok(unavailable.document.text.includes('x+2'));
  await screenshot('source-unavailable-pending');
  pass('real React UI source outage retains B intent and prior source snapshot');
  // External owner modifies same exact source region while local B is pending.
  const external = written.replace('x+2', 'x+4');
  control('set', id, { text: external });
  control('offline', id, { offline: false });
  let status = await checkSource(name);
  await until(async () => {
    const s = await ownSource(name);
    return s.pendingSource || s.link.conflict;
  }, 'External same-region edit silently disappeared');
  if ((await ownSource(name)).pendingSource) {
    await status.getByRole('button', { name: '定位对应对象', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .locator('.source-object')
      .filter({ hasText: 'x+4' })
      .getByRole('button', { name: '确认这是对应对象', exact: true })
      .click();
    await until(
      async () => (await ownSource(name)).link.conflict,
      'Manual identity confirmation did not preserve conflict',
    );
    status = page.locator('.source-status').filter({ hasText: name });
  }
  await status.getByRole('button', { name: '预览并解决', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.ok((await dialog.innerText()).includes('x+3'));
  assert.ok((await dialog.innerText()).includes('x+4'));
  await screenshot('source-conflict-both-sides');
  assertSourceBytes(id, external);
  pass(
    'real source conflict preview retains local B and external source; external bytes unchanged before decision',
  );
  await dialog.getByRole('button', { name: '保留纸张内容', exact: true }).click();
  await until(
    async () => {
      const s = await ownSource(name);
      return s.link.status === 'clean' && s.document.text.includes('x+3');
    },
    'Explicit conflict decision not written',
    20000,
  );
  assertSourceBytes(id, written.replace('x+2', 'x+3'));
  pass('explicit UI conflict choice writes only the selected owned source region');
}
async function pen({ finish = true, y = 0.55 } = {}) {
  await represent('a');
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  const sheet = page.locator('.paper-sheet');
  await sheet.scrollIntoViewIfNeeded();
  const box = await sheet.boundingBox();
  assert.ok(box);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const visible = {
    left: Math.max(20, box.x + 20),
    right: Math.min(viewport.width - 20, box.x + box.width - 20),
    top: Math.max(100, box.y + 20),
    bottom: Math.min(viewport.height - 150, box.y + box.height - 20),
  };
  assert.ok(
    visible.right > visible.left && visible.bottom > visible.top,
    'Paper has no visible input area',
  );
  const points = [
    [0.2, y],
    [0.24, y + 0.02],
    [0.3, y + 0.03],
    [0.35, y + 0.045],
  ].map(([x, y]) => ({
    x: visible.left + (visible.right - visible.left) * x,
    y: visible.top + (visible.bottom - visible.top) * y,
  }));
  assert.ok(
    await page.evaluate(
      (at) => !!document.elementFromPoint(at.x, at.y)?.closest('.paper-sheet'),
      points[0],
    ),
    'Synthetic pen must hit visible paper rather than an offscreen coordinate',
  );
  const props = { pointerType: 'pen', force: 0.67, tiltX: 13, tiltY: -9 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points[0], ...props });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    ...points[0],
    ...props,
  });
  for (const at of points.slice(1))
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      button: 'left',
      buttons: 1,
      ...at,
      ...props,
    });
  if (finish)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      ...points.at(-1),
      ...props,
    });
}
const strokes = (note) =>
  note.pages.flatMap((p) => p.objects).filter((o) => o.kind === 'stroke' && !o.deleted);
async function restart() {
  await device?.close();
  device = undefined;
  adb('shell', 'am force-stop local.quietpaper');
  adb('shell', 'am start -f 0x10008000 -n local.quietpaper/.MainActivity');
  await connect();
  await openNote();
}
async function recovery() {
  await openNote();
  const previousIds = new Set(strokes(await ownNote()).map((o) => o.id));
  await pen();
  const saved = await until(
    async () => strokes(await ownNote()).find((o) => !previousIds.has(o.id)),
    'Synthetic pen stroke not durably saved',
  );
  assert.ok(
    saved.points.some(
      (p) => Math.abs(p.pressure - 0.67) < 0.02 && p.tiltX === 13 && p.tiltY === -9,
    ),
  );
  await restart();
  assert.deepEqual(strokes(await ownNote()).find((o) => o.id === saved.id).points, saved.points);
  pass('Android force-stop/reopen preserves completed synthetic pen samples', {
    samples: saved.points.length,
    pressure: 0.67,
    tiltX: 13,
    tiltY: -9,
    input: 'CDP synthetic pen, not hardware',
  });
  await pen({ finish: false, y: 0.67 });
  const draftEntry = await until(
    async () =>
      Object.entries(await raw()).find(
        ([k, v]) => k.startsWith('draft:') && v?.noteId === noteId && v.points?.length >= 3,
      ),
    'Active pen checkpoint not durably saved',
  );
  const [draftKey, draft] = draftEntry;
  writeFileSync(`${out}/interrupted-draft.json`, JSON.stringify(draft, null, 2));
  await restart();
  const reloaded = await raw();
  assert.deepEqual(reloaded[draftKey].points, draft.points);
  await page.locator('.draft-recovery-banner').click();
  await page.getByRole('button', { name: '恢复到原纸张', exact: true }).first().click();
  await page.getByRole('button', { name: '原窗口已停止，恢复', exact: true }).click();
  const recovered = await until(async () => {
    const entry = await raw();
    const op = entry.current.project.operations.find((op) => op.payload?.draftId === draft.id);
    return op && strokes(await ownNote()).find((stroke) => stroke.id === op.payload.object.id);
  }, 'Interrupted checkpoint not recovered through real confirmation UI');
  assert.deepEqual(recovered.points, draft.points);
  assert.equal((await raw())[draftKey], undefined);
  assert.deepEqual(strokes(await ownNote()).find((o) => o.id === saved.id).points, saved.points);
  await screenshot('checkpoint-recovered');
  pass(
    'force-stop mid synthetic stroke → persisted orphan checkpoint → real UI confirmation preserves exact original samples',
  );
}
try {
  await connect();
  if (previousRun) {
    noteTitle = previousRun.noteTitle;
    noteId = previousRun.noteId;
    assert.ok(noteId && (await ownNote()));
    checks.push(...previousRun.checks);
    console.log('RESUME recovery/package only; source checks retained from', resumePath);
  } else {
    await createNote();
    const md = await importFixture('md');
    await sourceFaults(md);
    await importFixture('tex');
  }
  if (process.env.GLOSSA_PRODUCT_STAGE !== 'package') await recovery();
  await verifyProjectPackage({ page, adb, raw, openNote, noteId, out, pass });
  assert.deepEqual(errors, []);
  pass('packaged app produced no uncaught page errors');
} catch (error) {
  console.error('FAIL', error.stack || error);
  try {
    await screenshot('failure');
    writeFileSync(`${out}/failure-page.txt`, await page.locator('body').innerText());
  } catch {}
  try {
    writeFileSync(
      `${out}/failure-window.xml`,
      adb(
        'shell',
        'uiautomator dump /sdcard/glossa-product-window.xml; cat /sdcard/glossa-product-window.xml',
      ),
    );
  } catch {}
  writeFileSync(`${out}/failure.txt`, String(error.stack || error));
  process.exitCode = 1;
} finally {
  writeFileSync(
    `${out}/result.json`,
    JSON.stringify(
      {
        runId,
        resumedFrom: resumePath,
        serial,
        noteTitle,
        noteId,
        checks,
        errors,
        passed: !process.exitCode,
        scope:
          'Packaged Android UI in dedicated emulator; synthetic pen input; no real stylus/palm/latency, external network, Office or Apple format claim.',
      },
      null,
      2,
    ),
  );
  // Disconnection does not clear the app data, fixture, source snapshots or journals.
  await device?.close().catch(() => {});
}
