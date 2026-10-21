import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = process.env.QP_TEST_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/block-manager-test*', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/></head><body><div id="root"></div><script type="module" src="/tests/block-manager-harness.tsx"></script></body></html>',
  }),
);
const open = async (query = '') => {
  await page.goto(`${base}/block-manager-test${query}`);
  await page.waitForFunction(() => !!window.blockManagerHarness);
  return page.evaluate(() => {
    const { engine, ...ids } = window.blockManagerHarness.ids;
    return { ids, state: window.blockManagerHarness.snapshot() };
  });
};
const snapshot = () => page.evaluate(() => window.blockManagerHarness.snapshot());
const chooseFormula = () =>
  page.getByRole('checkbox', { name: '移动段落 2：a+b=c', exact: true }).check();

try {
  let initial = await open();
  await page.getByRole('textbox', { name: '拆分后的新块名称' }).fill('跨页论证');
  await chooseFormula();
  assert.ok((await page.locator('.bm-comparison .paper-preview').count()) >= 2);
  await page.getByRole('button', { name: '确认拆分', exact: true }).click();
  let state = await snapshot(),
    note = state.notes.find((note) => note.id === initial.ids.noteId),
    baseNote = initial.state.notes.find((note) => note.id === initial.ids.noteId);
  assert.equal(note.blocks.length, 3);
  const split = note.blocks.find((block) => block.title === '跨页论证');
  assert.deepEqual(
    split.segments.map((segment) => segment.id),
    [initial.ids.equationSegment],
  );
  assert.deepEqual(
    note.blocks
      .find((block) => block.id === initial.ids.block)
      .segments.map((segment) => segment.id),
    [initial.ids.firstSegment, initial.ids.lastSegment],
  );
  assert.deepEqual(note.pages, baseNote.pages);
  console.log(
    'PASS: real tablet split moves only chosen stable segments across pages and leaves every A object unchanged.',
  );

  initial = await open();
  await page.getByRole('tab', { name: '合并', exact: true }).click();
  await page.getByRole('checkbox', { name: '合并 基础关系', exact: true }).check();
  await page.getByRole('checkbox', { name: '合并 图形观察', exact: true }).check();
  await page.getByRole('textbox', { name: '合并后的知识块名称' }).fill('整体知识');
  await page.getByRole('button', { name: '确认合并', exact: true }).click();
  state = await snapshot();
  note = state.notes.find((note) => note.id === initial.ids.noteId);
  baseNote = initial.state.notes.find((note) => note.id === initial.ids.noteId);
  assert.equal(note.blocks.length, 1);
  assert.equal(note.blocks[0].title, '整体知识');
  assert.deepEqual(
    note.blocks[0].segments.map((segment) => segment.id),
    [
      initial.ids.firstSegment,
      initial.ids.equationSegment,
      initial.ids.lastSegment,
      initial.ids.otherSegment,
    ],
  );
  assert.ok(note.blocks[0].relatedBlockIds.includes(initial.ids.targetBlock));
  assert.deepEqual(note.pages, baseNote.pages);
  console.log(
    'PASS: real merge preserves segment identities/order and outgoing cross-note relation without moving paper objects.',
  );

  initial = await open();
  await page.getByRole('tab', { name: '关联', exact: true }).click();
  await page
    .getByRole('combobox', { name: '选择关联目标知识块' })
    .selectOption(initial.ids.targetBlock);
  await page.getByRole('button', { name: '建立关联', exact: true }).click();
  state = await snapshot();
  note = state.notes.find((note) => note.id === initial.ids.noteId);
  assert.ok(
    note.blocks
      .find((block) => block.id === initial.ids.block)
      .relatedBlockIds.includes(initial.ids.targetBlock),
  );
  assert.deepEqual(
    state.notes.map((note) => note.pages),
    initial.state.notes.map((note) => note.pages),
  );
  console.log('PASS: cross-note logical link is independent from both notes’ A geometry.');

  initial = await open();
  await page.getByRole('textbox', { name: '拆分后的新块名称' }).fill('保留我的名称');
  await chooseFormula();
  await page.evaluate(() => window.blockManagerHarness.changeSource());
  await page.getByRole('button', { name: '确认拆分', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '拆分后的新块名称' }).inputValue(),
    '保留我的名称',
  );
  assert.equal(
    await page.getByRole('checkbox', { name: '移动段落 2：a+b=c', exact: true }).isChecked(),
    true,
  );
  assert.equal(
    (await snapshot()).notes.find((note) => note.id === initial.ids.noteId).blocks.length,
    2,
  );
  await page.getByRole('button', { name: '更新预览', exact: true }).click();
  assert.equal(
    await page.getByRole('checkbox', { name: '移动段落 2：x+b=c', exact: true }).isChecked(),
    true,
  );
  await page.getByRole('button', { name: '确认拆分', exact: true }).click();
  assert.equal(
    (await snapshot()).notes.find((note) => note.id === initial.ids.noteId).blocks.length,
    3,
  );
  console.log(
    'PASS: stale B preview blocks structural commit, retains selection/name, and succeeds after explicit refreshed preview.',
  );

  initial = await open();
  await chooseFormula();
  await page.evaluate(() => window.blockManagerHarness.moveSource());
  await page.getByRole('button', { name: '确认拆分', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(
    (await snapshot()).notes.find((note) => note.id === initial.ids.noteId).blocks.length,
    2,
  );
  console.log(
    'PASS: a changed A source version cannot be silently accepted from an old structural preview.',
  );

  initial = await open();
  await chooseFormula();
  await page.evaluate(() => window.blockManagerHarness.unrelatedInk());
  const beforeUnrelatedCommit = await snapshot();
  await page.getByRole('button', { name: '确认拆分', exact: true }).click();
  state = await snapshot();
  note = state.notes.find((note) => note.id === initial.ids.noteId);
  assert.equal(note.blocks.length, 3);
  assert.deepEqual(
    state.notes.map((note) => note.pages),
    beforeUnrelatedCommit.notes.map((note) => note.pages),
  );
  console.log(
    'PASS: unrelated later handwriting neither blocks a valid structural edit nor disappears.',
  );

  await open('?role=phone');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await open('?role=mac');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await open();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: phone/Mac render no structural manager; Escape closes the tablet dialog; no browser runtime errors.',
  );
} finally {
  await browser.close();
}
