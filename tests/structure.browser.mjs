import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/structure-test', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/></head><body><div id="root"></div><script type="module" src="/tests/structure-harness.tsx"></script></body></html>',
  }),
);
const base = process.env.QP_TEST_URL ?? 'http://127.0.0.1:5173';
const open = async () => {
  await page.goto(`${base}/structure-test`);
  await page.getByRole('button', { name: '修订公式', exact: true }).click();
  return page.getByRole('textbox', { name: '编辑已有公式', exact: true });
};
const snapshot = () => page.evaluate(() => window.structureHarness.snapshot());
try {
  let editor = await open();
  await editor.evaluate((el) => el.setSelectionRange(3, 4));
  await page.keyboard.insertText('y');
  assert.equal(await editor.inputValue(), '😀xy+x');
  await page.evaluate(() => window.structureHarness.remote(4, 5, 'z'));
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  let state = await snapshot();
  assert.equal(state.text, '😀xy+z');
  assert.equal(state.conflicts.length, 0);
  await page.locator('.structure-mapping').first().click();
  assert.ok(
    (await page.evaluate(() => window.structureHarness.lastJump)).every((id) =>
      id.startsWith('revision:'),
    ),
  );
  assert.ok((await page.locator('.structure-reference svg path').count()) > 0);
  console.log(
    'PASS real beforeinput selection preserves repeated-symbol identity and disjoint concurrent edits; jump selects active A revision; B reference shows editable-source vector preview',
  );

  editor = await open();
  await editor.evaluate((el) => el.setSelectionRange(3, 4));
  await page.keyboard.insertText('a');
  await page.evaluate(() => window.structureHarness.remote(2, 3, 'b'));
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  state = await snapshot();
  assert.equal(state.conflicts.filter((c) => !c.resolved).length, 1);
  console.log(
    'PASS actual editor branch preserves both candidates when the same repeated symbol is concurrently changed',
  );

  editor = await open();
  await editor.evaluate((el) => el.setSelectionRange(3, 4));
  await page.keyboard.press('Backspace');
  assert.equal(await editor.inputValue(), '😀x+x');
  await page.keyboard.press('Control+z');
  assert.equal(await editor.inputValue(), '😀xx+x');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await editor.inputValue(), '😀x+x');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  assert.equal((await snapshot()).text, '😀x+x');
  console.log('PASS concrete repeated-character deletion with session undo/redo');

  editor = await open();
  await editor.evaluate((el) => {
    el.setSelectionRange(3, 4);
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    el.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        inputType: 'insertCompositionText',
        data: '纸',
        isComposing: true,
      }),
    );
    el.value = '😀x纸+x';
    el.setSelectionRange(4, 4);
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertCompositionText',
        data: '纸',
        isComposing: true,
      }),
    );
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '纸' }));
  });
  assert.equal(await editor.inputValue(), '😀x纸+x');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  assert.equal((await snapshot()).text, '😀x纸+x');
  console.log(
    'PASS simulated IME composition verifies original selected range before creating a character operation',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
