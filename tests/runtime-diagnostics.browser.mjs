import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Simulated Android bridge: this checks the real application UI and reply handling only.
// It does not exercise onRenderProcessGone, Android storage, or an actual renderer exit.
let base = process.env.QP_TEST_URL ?? process.env.QUIET_PAPER_TEST_URL ?? 'http://127.0.0.1:5173';
let server;
let browser;
const selectedCase = process.env.QP_RUNTIME_DIAGNOSTICS_CASE ?? 'all';
assert.ok(['all', 'protocol'].includes(selectedCase), 'unknown runtime diagnostics test case');
const records = [
  {
    at: Date.UTC(2026, 9, 21, 8, 15, 30),
    kind: 'renderer-exit',
    didCrash: true,
    priority: 2,
    osApi: 34,
    webViewPackage: 'com.google.android.webview',
    webViewVersion: '138.0.7204.168',
    appVersion: '0.1.2-old',
  },
  {
    at: Date.UTC(2026, 9, 22, 7, 45, 10),
    kind: 'renderer-exit',
    didCrash: false,
    priority: 1,
    osApi: 35,
    webViewPackage: 'com.google.android.webview',
    webViewVersion: '139.0.7258.165-runtime-diagnostics-long-version-fixture',
    appVersion: '0.1.2-new',
  },
];
const normalize = (text) => text.replace(/\s+/gu, ' ').trim();

async function openApplication(mode, viewport) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', timezoneId: 'UTC' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ fixture, initialMode }) => {
      const state = { records: fixture, mode: initialMode, requests: [] };
      window.__runtimeDiagnosticsMock = state;
      window.QuietPaperNative = {
        getRole: () => 'tablet',
        getPlatform: () => 'android',
        getDeviceId: () => 'runtime-diagnostics-ui-fixture',
        getRuntimeDiagnostics: (requestId) => {
          state.requests.push({ requestId, mode: state.mode });
          // Even an empty runtime payload must not turn an explicit native read failure
          // into the successful "no interruptions" screen.
          let result;
          if (state.mode === 'invalid')
            result = {
              ok: false,
              type: 'runtime-diagnostics',
              error: 'runtime-diagnostics-invalid',
              needsRecovery: true,
              runtime: [],
            };
          else if (state.mode === 'missing-runtime')
            result = { ok: true, type: 'runtime-diagnostics' };
          else if (state.mode === 'invalid-runtime')
            result = { ok: true, type: 'runtime-diagnostics', runtime: { records: state.records } };
          else if (state.mode === 'empty')
            result = { ok: true, type: 'runtime-diagnostics', runtime: [] };
          else result = { ok: true, type: 'runtime-diagnostics', runtime: state.records };
          queueMicrotask(() =>
            window.dispatchEvent(
              new CustomEvent('quietpaper-native', { detail: { requestId, ...result } }),
            ),
          );
        },
      };
    },
    { fixture: records, initialMode: mode },
  );
  await page.goto(base);
  await page.locator('.app-shell').waitFor();
  return { context, page, errors };
}

async function openActivity(page) {
  const navigation = page.getByRole('button', { name: '导航', exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole('button', { name: '运行状态', exact: true }).click();
  // The activity shortcut also exists in the mobile drawer; dismiss its scrim so
  // subsequent clicks target the actual page instead of an open navigation overlay.
  const scrim = page.locator('.sidebar-scrim');
  if (await scrim.isVisible())
    await scrim.click({ position: { x: page.viewportSize().width - 8, y: 20 } });
  await page.getByRole('heading', { name: '运行状态', exact: true }).waitFor();
}

async function assertRecords(page, dialog) {
  await dialog.waitFor();
  const articles = dialog.locator('.runtime-records article');
  assert.equal(await articles.count(), 2, 'both native records must be visible');
  assert.deepEqual(await articles.locator('strong').allTextContents(), ['系统终止', '异常退出']);
  const newestFirst = [...records].reverse();
  const displayedTimes = await page.evaluate(
    (values) => values.map((at) => new Date(at).toLocaleString()),
    newestFirst.map((record) => record.at),
  );
  const expectedText = [];
  for (const [index, record] of newestFirst.entries()) {
    const article = articles.nth(index);
    assert.equal(
      await article.locator('time').getAttribute('datetime'),
      new Date(record.at).toISOString(),
    );
    assert.equal(
      normalize(await article.locator('time').innerText()),
      normalize(displayedTimes[index]),
    );
    assert.deepEqual(await article.locator('dt').allTextContents(), [
      '应用',
      'Android API',
      '书写组件',
    ]);
    assert.deepEqual(await article.locator('dd').allTextContents(), [
      `Glossa ${record.appVersion}`,
      String(record.osApi),
      record.webViewVersion,
    ]);
    expectedText.push(
      record.didCrash ? '异常退出' : '系统终止',
      displayedTimes[index],
      '应用',
      `Glossa ${record.appVersion}`,
      'Android API',
      String(record.osApi),
      '书写组件',
      record.webViewVersion,
    );
  }
  // The modal contains the record fields themselves, without added explanatory
  // copy or fine-print helpers. Whitespace normalization is independent of layout.
  assert.equal(
    normalize(await dialog.innerText()),
    normalize(['窗口记录', ...expectedText].join(' ')),
  );
  assert.equal(await dialog.locator('small, [role="note"], .helper-text, .help-text').count(), 0);
}

async function assertNoOverflow(page, dialog) {
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.equal(sizes.viewport, 390);
  assert.ok(
    sizes.document <= sizes.viewport + 1,
    `page overflow: ${sizes.document} > ${sizes.viewport}`,
  );
  const modal = await dialog.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  assert.ok(
    modal.scroll <= modal.client + 1,
    `record modal overflow: ${modal.scroll} > ${modal.client}`,
  );
}

try {
  if (process.env.QP_TEST_SERVE === '1') {
    const { createServer } = await import('vite');
    server = await createServer({
      root: new URL('..', import.meta.url).pathname,
      configFile: false,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}`;
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    args: ['--no-sandbox'],
    headless: true,
  });

  if (selectedCase !== 'protocol') {
    // Check 1: real navigation and button clicks render both records, newest first.
    const success = await openApplication('success', { width: 1440, height: 1000 });
    try {
      await openActivity(success.page);
      await success.page.getByRole('button', { name: '窗口记录', exact: true }).click();
      const dialog = success.page.getByRole('dialog', { name: '窗口记录', exact: true });
      await assertRecords(success.page, dialog);
      await success.page.setViewportSize({ width: 390, height: 844 });
      await assertNoOverflow(success.page, dialog);
      await assertRecords(success.page, dialog);
      assert.equal(
        await success.page.evaluate(() => window.__runtimeDiagnosticsMock.requests.length),
        1,
      );
      assert.deepEqual(success.errors, []);
      console.log(
        'PASS simulated-bridge UI: window records show latest-first exit type, time, app/API/component versions, with no explanatory fine print or 390px horizontal overflow',
      );
    } finally {
      await success.context.close();
    }

    // Check 2: a damaged-store native failure remains an error, never empty success.
    const failure = await openApplication('invalid', { width: 390, height: 844 });
    try {
      await openActivity(failure.page);
      await failure.page.getByRole('button', { name: '窗口记录', exact: true }).click();
      const alert = failure.page.getByRole('alert');
      await alert.waitFor();
      assert.match(await alert.innerText(), /窗口记录.*不可读/u);
      assert.equal(
        await failure.page.getByRole('dialog', { name: '窗口记录', exact: true }).count(),
        0,
      );
      assert.equal(await failure.page.getByText('暂无窗口记录', { exact: true }).count(), 0);
      assert.deepEqual(
        await failure.page.evaluate(() => window.__runtimeDiagnosticsMock.records),
        records,
      );
      await failure.page.getByRole('button', { name: '关闭错误', exact: true }).click();
      await alert.waitFor({ state: 'hidden' });
      await failure.page.getByRole('button', { name: '立即整理', exact: true }).click();
      await failure.page.getByRole('button', { name: '搜索笔记', exact: true }).click();
      await failure.page.getByRole('heading', { name: '所有笔记', exact: true }).waitFor();
      await failure.page.evaluate(() => {
        window.__runtimeDiagnosticsMock.mode = 'success';
      });
      await openActivity(failure.page);
      await failure.page.getByRole('button', { name: '窗口记录', exact: true }).click();
      const dialog = failure.page.getByRole('dialog', { name: '窗口记录', exact: true });
      await assertRecords(failure.page, dialog);
      await assertNoOverflow(failure.page, dialog);
      assert.deepEqual(
        await failure.page.evaluate(() =>
          window.__runtimeDiagnosticsMock.requests.map((request) => request.mode),
        ),
        ['invalid', 'success'],
      );
      assert.deepEqual(failure.errors, []);
      console.log(
        'PASS simulated-bridge UI: failed diagnostic read shows an error instead of empty success; navigation and retry remain usable',
      );
    } finally {
      await failure.context.close();
    }
  }

  // Check 3: malformed successful replies are protocol errors, distinct from a valid empty array.
  const protocol = await openApplication('missing-runtime', { width: 390, height: 844 });
  try {
    await openActivity(protocol.page);
    for (const mode of ['missing-runtime', 'invalid-runtime']) {
      await protocol.page.evaluate((nextMode) => {
        window.__runtimeDiagnosticsMock.mode = nextMode;
      }, mode);
      await protocol.page.getByRole('button', { name: '窗口记录', exact: true }).click();
      const alert = protocol.page.getByRole('alert');
      await alert.waitFor();
      assert.match(await alert.innerText(), /窗口记录.*不可读/u);
      assert.equal(
        await protocol.page.getByRole('dialog', { name: '窗口记录', exact: true }).count(),
        0,
      );
      assert.equal(await protocol.page.getByText('暂无窗口记录', { exact: true }).count(), 0);
      assert.deepEqual(
        await protocol.page.evaluate(() => window.__runtimeDiagnosticsMock.records),
        records,
      );
      await protocol.page.getByRole('button', { name: '关闭错误', exact: true }).click();
      await alert.waitFor({ state: 'hidden' });
    }
    await protocol.page.evaluate(() => {
      window.__runtimeDiagnosticsMock.mode = 'empty';
    });
    await protocol.page.getByRole('button', { name: '窗口记录', exact: true }).click();
    const dialog = protocol.page.getByRole('dialog', { name: '窗口记录', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('heading', { name: '暂无窗口记录', exact: true }).waitFor();
    assert.equal(normalize(await dialog.innerText()), '窗口记录 暂无窗口记录');
    assert.equal(await dialog.locator('.runtime-records article').count(), 0);
    assert.equal(await protocol.page.getByRole('alert').count(), 0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await protocol.page.getByRole('button', { name: '搜索笔记', exact: true }).click();
    await protocol.page.getByRole('heading', { name: '所有笔记', exact: true }).waitFor();
    await openActivity(protocol.page);
    await protocol.page.getByRole('button', { name: '立即整理', exact: true }).click();
    assert.deepEqual(
      await protocol.page.evaluate(() =>
        window.__runtimeDiagnosticsMock.requests.map((request) => request.mode),
      ),
      ['missing-runtime', 'invalid-runtime', 'empty'],
    );
    assert.deepEqual(protocol.errors, []);
    console.log(
      'PASS simulated-bridge protocol UI: ok:true without runtime and non-array runtime produce errors rather than empty success; runtime:[] shows 暂无窗口记录, and navigation/processing remain usable with no page errors',
    );
  } finally {
    await protocol.context.close();
  }
  console.log(
    `Runtime diagnostics UI acceptance: ${selectedCase === 'protocol' ? '1 targeted protocol check; previous 2 checks not run' : '3 checks'}; simulated bridge only, not Android renderer-exit validation.`,
  );
} finally {
  await browser?.close();
  await server?.close();
}
