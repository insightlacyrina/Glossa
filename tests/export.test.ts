import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotebookEngine } from '../src/domain.ts';
import { exportReadingHtml, exportStructuredMarkdown } from '../src/export.ts';

function fixture() {
  const engine = new NotebookEngine(undefined, 'export-tablet', 'tablet');
  const noteId = engine.createNote('阅读与源引用');
  const pageId = engine.getNote(noteId).pages[0].id;
  const formulaId = engine.addText(
    noteId,
    pageId,
    'a+b=c',
    { x: 60, y: 80, width: 300, height: 50 },
    'formula',
  );
  const strokeId = engine.addStroke(
    noteId,
    pageId,
    [
      { x: 10, y: 120, pressure: 0, tiltX: 0, tiltY: 20, time: 10 },
      { x: 20, y: 125, pressure: 0.2, tiltX: 0, tiltY: 20, time: 20 },
      { x: 30, y: 120, pressure: 1, tiltX: 0, tiltY: 20, time: 30 },
    ],
    { width: 4, color: '#345678' },
  );
  const blockId = engine.createBlock(noteId, '知识块', [formulaId, strokeId]);
  const formulaSegment = engine.recognize(noteId, blockId, [formulaId], 'a+b=c', {
    kind: 'formula',
    deterministic: true,
    confidence: 1,
  });
  engine.recognize(noteId, blockId, [strokeId], '关系图', {
    kind: 'reference',
    confirmed: true,
    confidence: 1,
  });
  return { engine, noteId, formulaId, strokeId, formulaSegment };
}

test('HTML and Markdown snapshots retain stable note/block/segment/object identities and formulas', () => {
  const { engine, noteId, formulaSegment, formulaId, strokeId } = fixture();
  const note = engine.getNote(noteId);
  const html = exportReadingHtml(note),
    markdown = exportStructuredMarkdown(note);
  for (const output of [html, markdown]) {
    assert.ok(output.includes(noteId));
    assert.ok(output.includes(formulaSegment));
    assert.ok(output.includes(note.blocks[0].id));
    assert.ok(output.includes(formulaId));
    assert.ok(output.includes(strokeId));
    assert.ok(output.includes(note.blocks[0].segments[0].chars[0].id));
    assert.ok(output.includes('a+b=c'));
    assert.match(output, /<svg/);
    assert.match(output, /非可编辑 A 工程包|不包含可恢复编辑的 A 工程数据/);
    assert.ok(!output.includes('tiltX'));
  }
  assert.ok(markdown.includes('```math\na+b=c\n```'));
  assert.ok(html.includes("default-src 'none'"));
});

test('SVG preview varies stroke width by pressure and needs no original project on reading device', () => {
  const { engine, noteId } = fixture();
  const html = exportReadingHtml(engine.getNote(noteId));
  const widths = [...html.matchAll(/stroke-width="([\d.]+)"/g)].map((match) => Number(match[1]));
  assert.ok(new Set(widths).size > 1);
  assert.ok(widths.every((width) => Number.isFinite(width) && width > 0));
  assert.ok(html.includes('<line x1="10" y1="120"'));
  assert.ok(!html.includes('http://127.0.0.1'));
});

test('unmapped candidates and unsupported objects remain visibly uncovered instead of false precision', () => {
  const { engine, noteId, strokeId } = fixture();
  const block = engine.getNote(noteId).blocks[0];
  engine.recognize(noteId, block.id, [strokeId], '不确定结果', {
    reason: '符号无法确认',
    preview: '<svg onload="alert(1)"></svg>',
  });
  const note = engine.getNote(noteId);
  note.pages[0].objects.push({
    id: 'unsupported-ref',
    pageId: note.pages[0].id,
    kind: 'reference',
    layerId: 'ink',
    bounds: { x: 40, y: 200, width: 250, height: 50 },
    version: 'v1',
    data: 'file:///private/document.key',
  });
  const html = exportReadingHtml(note),
    markdown = exportStructuredMarkdown(note);
  for (const output of [html, markdown]) {
    assert.ok(output.includes('符号无法确认'));
    assert.ok(output.includes('尚无可移植预览'));
    assert.ok(output.includes('附带预览格式未覆盖'));
    assert.ok(!output.includes('onload='));
    assert.ok(!output.includes('file:///private'));
  }
});

test('all labels/attributes are escaped and unsafe image/color URLs never become active content', () => {
  const { engine, noteId } = fixture();
  const note = engine.getNote(noteId);
  note.title = '</title><script>alert("title")</script>';
  note.tags = ['<img src=x onerror=alert(1)>'];
  note.blocks[0].title = '<svg onload="alert(2)">';
  note.blocks[0].segments[0].text =
    '```\n</code></pre><iframe src="https://evil.example"></iframe>';
  note.pages[0].objects[0].text = '</text><script>alert("svg")</script>';
  note.pages[0].objects[0].color = 'url(https://evil.example/pixel)';
  note.pages[0].objects.push({
    id: 'image" onload="alert(1)',
    pageId: note.pages[0].id,
    kind: 'image',
    layerId: 'ink',
    bounds: { x: 0, y: 0, width: 200, height: 100 },
    version: 'x',
    data: 'data:image/svg+xml,<svg onload=alert(1)></svg>',
  });
  const html = exportReadingHtml(note),
    markdown = exportStructuredMarkdown(note);
  for (const output of [html, markdown]) {
    // Formula source is intentionally lossless inside a dynamically sized code fence.
    const activeOutput =
      output === markdown ? output.replace(/^(`{3,})math\n[\s\S]*?\n\1/gm, '') : output;
    assert.ok(!activeOutput.includes('<script>'));
    assert.ok(!activeOutput.includes('<iframe '));
    assert.ok(!output.includes('href="https://evil.example'));
    assert.ok(!output.includes('url(https://evil.example'));
    assert.ok(!output.includes('data:image/svg+xml'));
    assert.ok(!output.includes('" onload="alert(1)'));
    assert.ok(output.includes('&lt;'));
  }
  assert.ok(markdown.includes('````math\n```\n</code>'));
});

test('raster image previews are embedded, and active revisions hide replaced originals in paper snapshot', () => {
  const { engine, noteId, formulaSegment, formulaId } = fixture();
  const pageId = engine.getNote(noteId).pages[0].id;
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  engine.addImage(noteId, pageId, png);
  engine.editSegment(noteId, formulaSegment, 'x+b=c');
  const note = engine.getNote(noteId),
    html = exportReadingHtml(note);
  assert.ok(html.includes(`href="${png}"`));
  assert.ok(html.includes('x+b=c'));
  assert.ok(!html.includes(`data-object-id="${formulaId}"`));
  assert.ok(html.includes('data-object-id="revision:'));
});
