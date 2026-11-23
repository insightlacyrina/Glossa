import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/ink-test', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><style>.paper-sheet{width:794px;height:1123px;touch-action:none}</style></head><body><div id="root"></div><script type="module" src="/tests/ink-harness.tsx"></script></body></html>',
  }),
);
try {
  await page.goto(`${process.env.QP_TEST_URL ?? 'http://127.0.0.1:5173'}/ink-test`);
  await page.waitForFunction(() => window.inkPerformance);
  const metrics = await page.evaluate(() => ({
    ...window.inkPerformance,
    pathNodes: document.querySelectorAll('[data-ink-stroke]').length,
    svgNodes: document.querySelectorAll('.paper-sheet *').length,
    pathBytes: [...document.querySelectorAll('[data-ink-stroke]')].reduce(
      (n, p) => n + p.getAttribute('d').length,
      0,
    ),
  }));
  assert.equal(metrics.strokeCount, 1000);
  assert.equal(metrics.sampleCount, 60000);
  assert.equal(metrics.pathNodes, 1000);
  assert.ok(metrics.svgNodes < 2100);
  const bounds = await page.locator('.paper-sheet').boundingBox();
  const started = Date.now();
  await page.mouse.move(bounds.x + 50, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 150, bounds.y + 45, { steps: 20 });
  await page.mouse.up();
  await page.waitForFunction(() => document.getElementById('committed').textContent === '1');
  assert.equal(await page.locator('[data-ink-stroke]').count(), 1001);
  const raster = await page.evaluate(async () => {
    const { strokeOutline } = await import('/src/ink.ts');
    const points = [
      { x: 15, y: 30, pressure: 0 },
      { x: 65, y: 30, pressure: 0.2 },
      { x: 80, y: 60, pressure: 1 },
      { x: 40, y: 80, pressure: 0.8 },
      { x: 20, y: 50, pressure: 0.1 },
    ].map((p, i) => ({ ...p, tiltX: 0, tiltY: 0, time: i }));
    const old = points
      .slice(1)
      .map(
        (p, i) =>
          `<path d="M${points[i].x},${points[i].y}L${p.x},${p.y}" fill="none" stroke="#39353b" stroke-linecap="round" stroke-width="${5 * (0.4 + ((p.pressure + points[i].pressure) / 2) * 1.2)}"/>`,
      )
      .join('');
    const current = `<path d="${strokeOutline(points, 5)}" fill="#39353b" fill-rule="nonzero"/>`;
    async function pixels(content) {
      // Sample the contours in paper coordinates with subpixel resolution.
      // At 1×, antialiasing each legacy cap independently biases the edge comparison.
      const size = 110 * 8;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 110 110">${content}</svg>`,
        img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, size, size).data;
    }
    const a = await pixels(old),
      b = await pixels(current);
    let oldArea = 0,
      newArea = 0,
      difference = 0;
    for (let i = 3; i < a.length; i += 4) {
      const before = a[i] > 127,
        after = b[i] > 127;
      oldArea += Number(before);
      newArea += Number(after);
      difference += Number(before !== after);
    }
    return { oldArea, newArea, difference, relativeContourDifference: difference / oldArea };
  });
  assert.ok(raster.relativeContourDifference < 0.02, JSON.stringify(raster));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      test: '1000 editable strokes, 60000 original samples and live pointer input',
      ...metrics,
      raster,
      liveStrokeWallMs: Date.now() - started,
      previousSegmentPathNodes: 59000,
      pathNodeReductionPercent: Math.round((1 - metrics.pathNodes / 59000) * 10000) / 100,
    }),
  );
} finally {
  await browser.close();
}
