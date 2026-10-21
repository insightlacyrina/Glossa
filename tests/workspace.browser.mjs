import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
let server;
let base = process.env.QUIET_PAPER_TEST_URL || 'http://127.0.0.1:5174';
if (process.env.QP_TEST_SERVE === '1') {
  const { createServer } = await import('vite');
  server = await createServer({
    configFile: false,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  base = 'http://127.0.0.1:' + server.httpServer.address().port;
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
async function open(context) {
  const page = await context.newPage();
  await page.goto(base + '/tests/fixtures/workspace-harness.html');
  await page.waitForFunction(
    () => window.workspaceHarness?.ready && window.workspaceHarness?.engine,
  );
  return page;
}
try {
  const context = await browser.newContext();
  const first = await open(context),
    second = await open(context);
  const a = await first.evaluate(() => ({
    writer: window.workspaceHarness.engine.deviceId,
    installation: window.workspaceHarness.installationId,
  }));
  const b = await second.evaluate(() => ({
    writer: window.workspaceHarness.engine.deviceId,
    installation: window.workspaceHarness.installationId,
  }));
  assert.notEqual(a.writer, b.writer);
  assert.equal(a.installation, b.installation);
  const rollback = await first.evaluate(async () => {
    const w = window.workspaceHarness,
      before = w.engine.exportProject();
    const ok = w.transact((e) => {
      e.setSetting('must-not-exist', 'uncommitted');
      e.manageNote('missing-note', { title: 'never' });
    });
    await w.waitForSave();
    return {
      ok,
      before,
      after: w.getEngine().exportProject(),
      value: w.getEngine().state.settings['must-not-exist'],
    };
  });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.after, rollback.before);
  assert.equal(rollback.value, undefined);
  console.log(
    'PASS: real hook transactions roll back earlier settings on failure; two tabs have independent writers and one stable installation identity.',
  );
  const baseline = await first.evaluate(() => window.workspaceHarness.getEngine().exportProject());
  await first.evaluate(async () => {
    const w = window.workspaceHarness;
    w.transact((e) => e.createNote('Before restore'));
    await w.waitForSave();
  });
  await second.evaluate(async (json) => {
    const w = window.workspaceHarness;
    await w.importProject(json);
  }, baseline);
  await first.waitForFunction(() => window.workspaceHarness.saveState.includes('本窗口只读'));
  const restored = await second.evaluate(async () => {
    const w = window.workspaceHarness;
    await w.listRecoverySnapshots();
    return {
      titles: w.getEngine().state.notes.map((n) => n.title),
      recoveries: (await w.listRecoverySnapshots()).length,
    };
  });
  assert(!restored.titles.includes('Before restore'));
  assert(restored.recoveries > 0);
  const rejected = await first.evaluate(() =>
    window.workspaceHarness.transact((e) => e.createNote('Late overwrite')),
  );
  assert.equal(rejected, false);
  // With no provider before or after import, the new epoch must still restart recognition.
  await second.evaluate(async () => {
    const w = window.workspaceHarness;
    w.configureProcessor({ idleMs: 5 });
    w.transact((e) => {
      const n = e.createNote('After restore');
      e.addText(n, e.getNote(n).pages[0].id, 'New typed content');
    });
    await w.waitForSave();
  });
  await second
    .waitForFunction(
      () =>
        window.workspaceHarness
          .getEngine()
          .state.notes.find((n) => n.title === 'After restore')
          ?.blocks.some((b) => b.segments.some((s) => s.text === 'New typed content')),
      { timeout: 10000 },
    )
    .catch(async (error) => {
      console.log(
        await second.evaluate(() => ({
          error: window.workspaceHarness.error,
          status: window.workspaceHarness.statuses,
          notes: window.workspaceHarness
            .getEngine()
            .state.notes.map((n) => ({ title: n.title, blocks: n.blocks.length })),
        })),
      );
      throw error;
    });
  console.log(
    'PASS: same-ID restore replaces content, preserves recoveries, stops stale-window writes and restarts background processing without changing provider.',
  );
  const keptStroke = await second.evaluate(async () => {
    const w = window.workspaceHarness;
    let objectId;
    w.transact((e) => {
      const n = e.state.notes[0];
      objectId = e.addStroke(n.id, n.pages[0].id, [
        { x: 10, y: 20, pressure: 0.4, tiltX: 8, tiltY: 5, time: 1 },
        { x: 30, y: 40, pressure: 0.8, tiltX: 10, tiltY: 7, time: 2 },
      ]);
    });
    await w.waitForSave();
    return objectId;
  });
  await second.getByRole('button', { name: '打开恢复列表', exact: true }).click();
  const recoveryCard = second
    .locator('.revision-card')
    .filter({ hasText: 'Before restore' })
    .first();
  await recoveryCard.getByRole('button', { name: '恢复', exact: true }).click();
  await second.getByRole('button', { name: '确认恢复此版本', exact: true }).click();
  await second.waitForFunction(() => window.recoveryRestored === true);
  const recoveryResult = await second.evaluate(async (stroke) => {
    const w = window.workspaceHarness;
    return {
      titles: w.getEngine().state.notes.map((n) => n.title),
      oldInkSaved: (await w.listRecoverySnapshots()).some((item) =>
        item.recovery.workspace.project.operations.some((op) => op.payload.object?.id === stroke),
      ),
    };
  }, keptStroke);
  assert(recoveryResult.titles.includes('Before restore'));
  assert(!recoveryResult.titles.includes('After restore'));
  assert(recoveryResult.oldInkSaved);
  await second.reload();
  await second.waitForFunction(
    () => window.workspaceHarness?.ready && window.workspaceHarness?.engine,
  );
  assert(
    (
      await second.evaluate(() =>
        window.workspaceHarness.getEngine().state.notes.map((n) => n.title),
      )
    ).includes('Before restore'),
  );
  console.log(
    'PASS: the actual RecoveryManager confirmation restores a selected snapshot, retains current ink in another recovery and survives reload.',
  );
  await context.close();

  const syncContext = await browser.newContext();
  const page = await open(syncContext);
  let release, seen;
  const requestSeen = new Promise((resolve) => {
    seen = resolve;
  });
  const initial = await page.evaluate(() => window.workspaceHarness.getEngine().exportProject());
  const responseOp = await page.evaluate(async () => {
    const { NotebookEngine } = await import('/src/domain.ts');
    const base = window.workspaceHarness.getEngine();
    const other = new NotebookEngine(base.project, 'delayed-remote', 'tablet');
    other.createNote('Must never arrive after restore');
    return other.project.operations.at(-1);
  });
  const serverGeneration = 'test-generation-stable';
  let statusRequests = 0;
  await page.route('https://sync-test.invalid/api/status', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET',
          'access-control-allow-headers': 'authorization',
        },
      });
      return;
    }
    statusRequests++;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ protocol: 1, generation: serverGeneration }),
    });
  });
  await page.route('https://sync-test.invalid/api/sync', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'authorization,content-type',
        },
      });
      return;
    }
    assert.equal(route.request().postDataJSON().generation, serverGeneration);
    await new Promise((resolve) => {
      release = resolve;
      seen();
    });
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        protocol: 1,
        generation: serverGeneration,
        ops: [{ id: responseOp.id, mode: 'plain', payload: responseOp }],
        cursor: 1,
        hasMore: false,
      }),
    });
  });
  await page.evaluate(async () => {
    const w = window.workspaceHarness;
    await w.connect({
      url: 'https://sync-test.invalid',
      token: 'browser-test-token-with-enough-entropy',
      projectId: w.getEngine().project.id,
      mode: 'plain',
    });
  });
  await requestSeen;
  assert(statusRequests > 0);
  await page.evaluate(async (json) => {
    await window.workspaceHarness.importProject(json);
  }, initial);
  release();
  await page.waitForTimeout(150);
  const protectedState = await page.evaluate(() => ({
    titles: window.workspaceHarness.getEngine().state.notes.map((n) => n.title),
    sync: window.workspaceHarness.syncState,
  }));
  assert(!protectedState.titles.includes('Must never arrive after restore'));
  assert.equal(protectedState.sync, '未连接');
  console.log(
    'PASS: a real delayed HTTP response from the old connection cannot contaminate a restored same-ID project or reactivate its sync status.',
  );
  await syncContext.close();
  const exportContext = await browser.newContext();
  await exportContext.addInitScript(() => {
    const state = {
      fail: true,
      completed: [],
      discarded: [],
      sessions: [
        {
          sessionId: 'complete-1',
          name: '完整工程.quietpaper',
          mime: 'application/json',
          bytes: 2048,
          complete: true,
        },
        {
          sessionId: 'partial-2',
          name: '未完成工程.quietpaper',
          mime: 'application/json',
          bytes: 512,
          complete: false,
        },
      ],
    };
    window.exportRecoveryMock = state;
    const reply = (id, data) =>
      queueMicrotask(() =>
        window.dispatchEvent(
          new CustomEvent('quietpaper-native', { detail: { requestId: id, ok: true, ...data } }),
        ),
      );
    window.QuietPaperNative = {
      getRole: () => 'tablet',
      getDeviceId: () => 'export-install',
      getPendingExports: (id) => reply(id, { sessions: state.sessions }),
      completeExport: (id, session) => {
        if (state.fail) {
          state.fail = false;
          reply(id, { ok: false, error: 'simulated picker unavailable' });
        } else {
          state.completed.push(session);
          state.sessions = state.sessions.filter((s) => s.sessionId !== session);
          reply(id, {});
        }
      },
      discardExport: (id, session) => {
        state.discarded.push(session);
        state.sessions = state.sessions.filter((s) => s.sessionId !== session);
        reply(id, {});
      },
    };
  });
  const exportPage = await open(exportContext);
  await exportPage.getByRole('button', { name: '打开恢复列表', exact: true }).click();
  await exportPage.getByRole('button', { name: '继续导出', exact: true }).click();
  await exportPage.getByRole('alert').filter({ hasText: 'simulated picker unavailable' }).waitFor();
  assert.equal(await exportPage.getByRole('button', { name: '继续导出', exact: true }).count(), 1);
  await exportPage.getByRole('button', { name: '继续导出', exact: true }).click();
  await exportPage.waitForFunction(() => window.exportRecoveryMock.completed.length === 1);
  exportPage.once('dialog', (dialog) => dialog.dismiss());
  await exportPage.getByRole('button', { name: '清理导出暂存', exact: true }).click();
  assert.equal(await exportPage.evaluate(() => window.exportRecoveryMock.discarded.length), 0);
  exportPage.once('dialog', (dialog) => dialog.accept());
  await exportPage.getByRole('button', { name: '清理导出暂存', exact: true }).click();
  await exportPage.waitForFunction(() => window.exportRecoveryMock.discarded.length === 1);
  console.log(
    'PASS: actual export-recovery UI retains a failed pending export, retries completion and requires confirmation before discarding an incomplete staging session (simulated native bridge).',
  );
  await exportContext.close();
  console.log('Workspace browser acceptance: 5 checks passed.');
} finally {
  await browser.close();
  if (server) await server.close();
}
