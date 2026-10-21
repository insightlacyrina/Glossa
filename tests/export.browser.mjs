import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { NotebookEngine } from '../src/domain.ts';
import { exportReadingHtml } from '../src/export.ts';

const dir = await mkdtemp(join(tmpdir(), 'quiet-paper-reading-'));
const engine = new NotebookEngine(undefined, 'export-browser', 'tablet');
const noteId = engine.createNote('安全导出 <script>unsafe()</script>');
const pageId = engine.getNote(noteId).pages[0].id;
const objectId = engine.addStroke(noteId, pageId, [
  { x: 60, y: 90, pressure: 0.1, tiltX: 20, tiltY: 10, time: 0 },
  { x: 80, y: 80, pressure: 0.9, tiltX: 20, tiltY: 10, time: 16 },
  { x: 110, y: 100, pressure: 0.5, tiltX: 20, tiltY: 10, time: 32 },
]);
const block = engine.createBlock(noteId, '图形引用', [objectId]);
engine.recognize(noteId, block, [objectId], '<iframe src="https://evil.example"></iframe>', {
  kind: 'reference',
  confirmed: true,
});
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=';
engine.addImage(noteId, pageId, png, { x: 120, y: 90, width: 20, height: 20 });
const note = engine.getNote(noteId);
note.pages[0].objects[0].id += '" onload="unsafe()';
note.blocks[0].segments[0].source.objectIds = [note.pages[0].objects[0].id];
const file = join(dir, 'reading.html');
const html = exportReadingHtml(note);
await writeFile(file, html);
// The managed browser disallows file: navigation. A local transport serves this standalone artifact.
const transport = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
transport.listen(0, '127.0.0.1');
await once(transport, 'listening');
const readingUrl = `http://127.0.0.1:${transport.address().port}/reading.html`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const requests = [],
    dialogs = [];
  page.on('request', (request) => {
    if (request.url() !== readingUrl && !request.url().startsWith('data:'))
      requests.push(request.url());
  });
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(readingUrl);
  await page.waitForLoadState('load');
  assert.equal(await page.locator('script,iframe,[onload],[onerror]').count(), 0);
  assert.equal(await page.locator('h1').innerText(), note.title);
  assert.ok((await page.locator('.segment-text').innerText()).includes('<iframe'));
  assert.equal(await page.locator('svg image').count(), 1);
  assert.ok((await page.locator('svg line').count()) >= 2);
  const broken = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) =>
      links.filter((link) => !document.getElementById(link.getAttribute('href').slice(1))),
    )
    .then((value) => value.length);
  assert.equal(broken, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual(dialogs, []);
  console.log(
    'PASS: Chromium reads standalone HTML over a local transport with embedded B text/original geometry/image and no external dependency.',
  );
  console.log(
    'PASS: malicious labels/IDs create no script, iframe, event handler, dialog or network request.',
  );
  console.log('PASS: every intra-document source jump resolves to a stable object anchor.');
} finally {
  await browser.close();
  await new Promise((resolve) => transport.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
