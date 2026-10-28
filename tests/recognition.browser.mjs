import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
let server;
let base = process.env.QUIET_PAPER_TEST_URL;
if (!base) {
  server = await createServer({
    configFile: false,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
}
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/fixtures/recognition-harness.html`);
  const result = await page.evaluate(async () => {
    const { groupRecognitionObjects, rasterizeRecognitionGroup } = await import(
      '/src/recognition.ts'
    );
    const objects = [
      {
        id: 'a',
        revision: 'v1',
        kind: 'stroke',
        width: 3,
        points: [
          { x: 1000, y: 1000, pressure: 0.5 },
          { x: 1040, y: 1040, pressure: 1 },
        ],
      },
      {
        id: 'b',
        revision: 'v2',
        kind: 'stroke',
        width: 2,
        points: [
          { x: 1000, y: 1040 },
          { x: 1040, y: 1000 },
        ],
      },
    ];
    const before = JSON.stringify(objects);
    const group = groupRecognitionObjects(objects)[0];
    const png = await rasterizeRecognitionGroup(group, new AbortController().signal);
    const image = new Image();
    image.src = png;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let darkPixels = 0,
      whitePixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 100 && pixels[i + 3] === 255) darkPixels++;
      if (pixels[i] === 255 && pixels[i + 3] === 255) whitePixels++;
    }
    let unsafeRejected = false;
    try {
      await rasterizeRecognitionGroup(
        groupRecognitionObjects([
          { id: 'unsafe', revision: 'v', kind: 'image', data: 'https://example.com/image.png' },
        ])[0],
        new AbortController().signal,
      );
    } catch {
      unsafeRejected = true;
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 4096;
    sourceCanvas.height = 1024;
    sourceCanvas.getContext('2d').fillRect(0, 0, 200, 200);
    const reduced = await rasterizeRecognitionGroup(
      groupRecognitionObjects([
        { id: 'image', revision: 'v', kind: 'image', data: sourceCanvas.toDataURL() },
      ])[0],
      new AbortController().signal,
    );
    const reducedImage = new Image();
    reducedImage.src = reduced;
    await reducedImage.decode();
    return {
      png: png.startsWith('data:image/png;base64,'),
      width: image.width,
      height: image.height,
      darkPixels,
      whitePixels,
      unchanged: before === JSON.stringify(objects),
      unsafeRejected,
      reducedWidth: reducedImage.width,
      reducedHeight: reducedImage.height,
    };
  });
  assert.equal(result.png, true);
  assert.equal(result.width, 192);
  assert.equal(result.height, 192);
  assert(result.darkPixels > 100);
  assert(result.whitePixels > 100);
  assert.equal(result.unchanged, true);
  assert.equal(result.unsafeRejected, true);
  assert.equal(result.reducedWidth, 2048);
  assert.equal(result.reducedHeight, 512);
  console.log(
    'PASS: actual canvas raster contains grouped visible ink, opaque background, bounded crop; image OCR preserves aspect and rejects network URLs.',
  );
} finally {
  await browser.close();
  await server?.close();
}
