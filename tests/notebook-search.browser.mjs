import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const base = 'http://127.0.0.1:' + server.httpServer.address().port;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/chromium'),
  headless: true,
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.QuietPaperNative = {
      getRole: () => 'tablet',
      getDeviceId: () => 'search-browser-fixture',
      getPlatform: () => 'android',
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const calls = [];
  await context.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,x-goog-api-key',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Expose-Headers': 'Retry-After',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    calls.push(url.pathname);
    assert.equal(request.headers()['x-goog-api-key'], 'fake-notebook-search-key');
    if (url.pathname.endsWith('/models')) {
      await route.fulfill({
        headers,
        json: {
          models: [
            { name: 'models/gemini-embedding-002', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        },
      });
      return;
    }
    assert.ok(url.pathname.endsWith(':batchEmbedContents'));
    if (url.pathname.includes('gemini-embedding-002')) {
      await route.fulfill({
        status: 429,
        headers: { ...headers, 'Retry-After': '20' },
        json: { error: { message: 'Quota exhausted for this model' } },
      });
      return;
    }
    const { requests } = request.postDataJSON();
    assert.ok(requests.length <= 24);
    await route.fulfill({
      headers,
      json: {
        embeddings: requests.map(({ model, content }) => {
          assert.equal(model, 'models/gemini-embedding-001');
          const text = content.parts[0].text;
          assert.equal(typeof text, 'string');
          return { values: /速度保持|惯性定律/.test(text) ? [1, 0] : [0, 1] };
        }),
      },
    });
  });

  await page.goto(base);
  await page.locator('.paper-sheet').waitFor();
  await page.evaluate(async () => {
    const { NotebookEngine } = await import('/src/domain.ts');
    const { writeLocal } = await import('/src/storage.ts');
    const engine = new NotebookEngine();
    engine.setSetting('stages', {
      ocr: false,
      formula: false,
      classification: false,
      layout: false,
      structure: false,
      review: false,
    });
    const note = engine.createNote('物理笔记');
    const folder = engine.createFolder('第一学期');
    engine.manageNote(note, { folderId: folder });
    const first = engine.getNote(note).pages[0].id;
    const text = '示意图 🖋 e\u0301  ＡＢＣ';
    const object = engine.addText(note, first, text);
    const concept = engine.createBlock(note, '光学试验', [object]);
    engine.recognize(note, concept, [object], text, { deterministic: true });
    engine.createBlock(note, '惯性定律');
    const second = engine.addPage(note);
    engine.addText(note, second, '摆线方程与滚动');
    await writeLocal('current', {
      project: engine.project,
      epoch: 'search-browser-fixture',
      cursor: 0,
    });
  });
  await page.reload();
  await page.getByRole('heading', { name: '物理笔记', exact: true }).waitFor();
  await page.locator('.folder-item').filter({ hasText: '第一学期' }).click();
  const input = page.locator('.search-input');
  const result = page.locator('.notebook-search-results');
  const mark = page.locator('mark.search-location-mark');
  const back = async (query) => {
    assert.equal(await page.evaluate(() => window.glossaNavigateBack()), true);
    await input.waitFor();
    assert.equal(await input.inputValue(), query);
    assert.match(await page.locator('.folder-item.active').innerText(), /第一学期/);
  };

  await input.fill('é abc');
  await result.locator('.search-hit').waitFor();
  assert.equal(await result.locator('mark').innerText(), 'e\u0301  ＡＢＣ');
  await result.locator('.search-hit').click();
  await mark.waitFor();
  assert.equal(await mark.innerText(), 'e\u0301  ＡＢＣ');
  await back('é abc');

  await input.fill('摆线');
  const paperHit = result.locator('.search-hit').filter({ hasText: '摆线' });
  assert.match(await paperHit.innerText(), /第 2 页/);
  await paperHit.click();
  await mark.waitFor();
  assert.equal(await mark.innerText(), '摆线');
  assert.match(await page.locator('.paper-sheet').getAttribute('aria-label'), /2/);
  await back('摆线');
  assert.deepEqual(calls, []);
  console.log(
    'PASS actual notebook search opens exact stable text and raw second-page objects, and Back preserves query and folder',
  );

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '偏好与同步' });
  await modal.getByRole('button', { name: '外部模型', exact: true }).click();
  await modal.getByRole('switch', { name: '自动选模与限流切换' }).check();
  await modal.locator('input[name=key]').fill('fake-notebook-search-key');
  await modal.locator('input[name=allow-search]').check();
  assert.equal(await modal.locator('input[name=allow-recognition]').isChecked(), false);
  const discovery = page.waitForResponse('https://generativelanguage.googleapis.com/v1beta/models');
  await modal.getByRole('button', { name: '授权并启用' }).click();
  await modal.waitFor({ state: 'detached' });
  assert.equal((await discovery).status(), 200);

  await input.fill('速度保持');
  const semantic = result.locator('.search-hit').filter({ hasText: '惯性定律' });
  await semantic.waitFor({ timeout: 12_000 });
  assert.equal(await semantic.locator('mark').count(), 0);
  assert.deepEqual(calls, [
    '/v1beta/models',
    '/v1beta/models/gemini-embedding-002:batchEmbedContents',
    '/v1beta/models/gemini-embedding-001:batchEmbedContents',
  ]);
  await semantic.click();
  await page
    .locator('.structure-block-active')
    .getByRole('heading', { name: '惯性定律', exact: true })
    .waitFor();
  await back('速度保持');
  assert.ok(calls.every((path) => !path.endsWith(':generateContent')));
  assert.deepEqual(errors, []);
  console.log(
    'PASS same search field retrieves semantic concept using discovered Google embedding fallback after 429 with search-only consent',
  );
} finally {
  await browser.close();
  await server.close();
}
