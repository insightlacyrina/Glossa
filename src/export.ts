import type { Note, Page, PaperObject, Segment } from './domain';

/** These are portable B reading snapshots, never an editable A project or a recovery package. */
const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
const safeId = (kind: string, value: string): string =>
  `qp-${kind}-` +
  [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const number = (value: number | undefined, fallback = 0, low = -100000, high = 100000) =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, value!)) : fallback;
const color = (value?: string) =>
  value && /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8})$/i.test(value) ? value : '#35312f';
const safeImage = (value?: string): value is string =>
  !!value && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/]+={0,2}$/i.test(value);

function textSvg(object: PaperObject): string {
  const x = number(object.bounds.x),
    y = number(object.bounds.y);
  const fontSize = number(object.bounds.height / 1.7, 24, 8, 64);
  const lines = (object.text ?? '').split(/\r\n|\n|\r/);
  return `<text x="${x}" y="${y + fontSize}" fill="${color(object.color)}" font-size="${fontSize}" font-family="${object.kind === 'formula' ? 'serif' : 'sans-serif'}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? fontSize * 1.35 : 0}">${escapeHtml(line)}</tspan>`).join('')}</text>`;
}
function unsupportedSvg(object: PaperObject, reason = '此对象尚无可移植预览'): string {
  const { bounds } = object;
  const x = number(bounds.x),
    y = number(bounds.y),
    width = number(bounds.width, 160, 40),
    height = number(bounds.height, 48, 32);
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#f1ede7" stroke="#9d8874" stroke-dasharray="5 4"/><text x="${x + 8}" y="${y + 22}" font-size="14" fill="#654f3b">${escapeHtml(reason)}</text>`;
}

function objectSvg(object: PaperObject, anchor = true): string {
  let body: string;
  if (object.kind === 'stroke' || (object.kind === 'shape' && object.points?.length)) {
    const points = object.points ?? [],
      width = number(object.width, 2.4, 0.05, 100),
      stroke = color(object.color);
    if (!points.length) body = unsupportedSvg(object, '空笔迹：无有效预览');
    else if (points.length === 1)
      body = `<circle cx="${number(points[0].x)}" cy="${number(points[0].y)}" r="${(width * (0.35 + number(points[0].pressure, 0.5, 0, 1) * 0.9)) / 2}" fill="${stroke}"/>`;
    else
      body = points
        .slice(1)
        .map((point, index) => {
          const previous = points[index];
          const pressure =
            (number(previous.pressure, 0.5, 0, 1) + number(point.pressure, 0.5, 0, 1)) / 2;
          return `<line x1="${number(previous.x)}" y1="${number(previous.y)}" x2="${number(point.x)}" y2="${number(point.y)}" stroke="${stroke}" stroke-width="${width * (0.35 + pressure * 0.9)}" stroke-linecap="round"/>`;
        })
        .join('');
  } else if (object.kind === 'text' || object.kind === 'formula') body = textSvg(object);
  else if (object.kind === 'image' && safeImage(object.data))
    body = `<image x="${number(object.bounds.x)}" y="${number(object.bounds.y)}" width="${number(object.bounds.width, 100, 1)}" height="${number(object.bounds.height, 100, 1)}" href="${escapeHtml(object.data)}" preserveAspectRatio="xMidYMid meet"/>`;
  else if (object.kind === 'reference' && object.text) body = textSvg(object);
  else body = unsupportedSvg(object);
  return `<g${anchor ? ` id="${safeId('object', object.id)}"` : ''} data-object-id="${escapeHtml(object.id)}" data-object-version="${escapeHtml(object.version)}"${object.replacesObjectIds?.length ? ` data-replaces-object-ids="${escapeHtml(JSON.stringify(object.replacesObjectIds))}"` : ''}><title>${escapeHtml(object.kind)} · ${escapeHtml(object.id)}</title>${body}</g>`;
}

/** Fixed paper geometry is a self-contained visual reference; tilt/time/layers are not exported. */
function pageSvg(page: Page, objectIds?: string[]): string {
  const all = page.objects.filter((object) => !object.deleted);
  const replaced = new Set(all.flatMap((object) => object.replacesObjectIds ?? []));
  const selected = objectIds
    ? all.filter((object) => objectIds.includes(object.id))
    : all.filter((object) => !replaced.has(object.id));
  const width = number(page.width, 794, 100, 20000),
    height = number(page.height, 1123, 100, 20000);
  let viewBox = `0 0 ${width} ${height}`;
  if (objectIds && selected.length) {
    const x = Math.min(...selected.map((object) => number(object.bounds.x))) - 8,
      y = Math.min(...selected.map((object) => number(object.bounds.y))) - 8;
    const right =
      Math.max(
        ...selected.map((object) => number(object.bounds.x) + number(object.bounds.width, 1, 1)),
      ) + 8;
    const bottom =
      Math.max(
        ...selected.map((object) => number(object.bounds.y) + number(object.bounds.height, 1, 1)),
      ) + 8;
    viewBox = `${x} ${y} ${Math.max(32, right - x)} ${Math.max(32, bottom - y)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${escapeHtml(objectIds ? '原对象预览' : '纸张阅读快照')}" data-page-id="${escapeHtml(page.id)}"><rect x="0" y="0" width="${width}" height="${height}" fill="#fffdf8"/>${selected.map((object) => objectSvg(object, !objectIds)).join('')}</svg>`;
}

function sourceReferences(note: Note, segment: Segment): string {
  const ids = segment.source.objectIds;
  const sourceObjects = note.pages
    .flatMap((page) => page.objects)
    .filter((object) => !object.deleted);
  const missing = ids.filter((id) => !sourceObjects.some((object) => object.id === id));
  const previews = note.pages
    .filter((page) => page.objects.some((object) => ids.includes(object.id) && !object.deleted))
    .map((page) => pageSvg(page, ids))
    .join('');
  const image = safeImage(segment.preview)
    ? `<img alt="原内容预览" src="${escapeHtml(segment.preview)}"/>`
    : '';
  const unknownPreview =
    segment.preview && !safeImage(segment.preview)
      ? '<p class="uncovered">附带预览格式未覆盖；未执行未知 SVG 或链接。</p>'
      : '';
  const noMapping =
    segment.source.status !== 'exact'
      ? `<p class="unmapped">待校对：${escapeHtml(segment.source.reason ?? '尚无经过验证的对应关系')}</p>`
      : '';
  const missingLabel = missing.length
    ? `<p class="uncovered">源对象缺失，无法补足预览：${missing.map(escapeHtml).join('、')}</p>`
    : '';
  return `<div class="source-reference" data-source-status="${escapeHtml(segment.source.status)}" data-source-precision="${escapeHtml(segment.source.precision)}" data-source-ids="${escapeHtml(JSON.stringify(ids))}">${noMapping}${previews}${image}${unknownPreview}${missingLabel}${!ids.length && !image ? '<p class="uncovered">无可用源对象引用。</p>' : ''}</div>`;
}

function segmentHtml(note: Note, segment: Segment): string {
  const needsPreview = segment.kind === 'reference' || segment.source.status !== 'exact';
  const content =
    segment.kind === 'formula'
      ? `<pre class="formula"><code>${escapeHtml(segment.text)}</code></pre>`
      : `<p class="segment-text">${escapeHtml(segment.text).replace(/\r\n|\n|\r/g, '<br/>')}</p>`;
  const sourceLinks = segment.source.objectIds
    .map((id) => {
      const revision = note.pages
        .flatMap((page) => page.objects)
        .find((object) => !object.deleted && object.replacesObjectIds?.includes(id));
      return `<a href="#${safeId('object', revision?.id ?? id)}">${escapeHtml(id)}</a>`;
    })
    .join(' · ');
  return `<section id="${safeId('segment', segment.id)}" data-segment-id="${escapeHtml(segment.id)}" data-character-ids="${escapeHtml(JSON.stringify(segment.chars.filter((char) => !char.deleted).map((char) => char.id)))}">${content}<p class="source-ids">${escapeHtml(segment.source.status === 'exact' ? '对应对象' : '候选来源')}：${sourceLinks || '未映射'}</p>${needsPreview ? sourceReferences(note, segment) : ''}</section>`;
}

/** Standalone offline HTML; no scripts, remote dependencies or editable A state. */
export function exportReadingHtml(note: Note): string {
  const blocks = note.blocks
    .map(
      (block) =>
        `<article id="${safeId('block', block.id)}" data-block-id="${escapeHtml(block.id)}"><h2>${escapeHtml(block.title)}</h2>${block.segments
          .filter((segment) => !segment.deleted)
          .map((segment) => segmentHtml(note, segment))
          .join(
            '',
          )}${block.relatedBlockIds.length ? `<p class="relations">知识关系：${block.relatedBlockIds.map((id) => (note.blocks.some((other) => other.id === id) ? `<a href="#${safeId('block', id)}">${escapeHtml(id)}</a>` : `<span>跨笔记引用 ${escapeHtml(id)}</span>`)).join(' · ')}</p>` : ''}</article>`,
    )
    .join('');
  const pages = note.pages
    .map(
      (page, index) =>
        `<figure id="${safeId('page', page.id)}"><figcaption>纸张 ${index + 1}</figcaption>${pageSvg(page)}</figure>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"/><title>${escapeHtml(note.title)} · 笺注阅读快照</title><style>body{margin:0;background:#eeebe5;color:#302c29;font:17px/1.8 system-ui,sans-serif}main{max-width:850px;margin:64px auto;padding:0 28px}h1,h2{font-family:serif;font-weight:500}h1{font-size:40px}h2{margin-top:44px}a{color:#6f6048;overflow-wrap:anywhere}.source-ids,.relations,figcaption,.snapshot-kind{font-size:13px;color:#736b61}.source-reference{padding:16px;background:#f8f5ee;margin:16px 0}svg,img{display:block;width:100%;height:auto}figure{margin:32px 0}.formula{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f8f5ee}.unmapped,.uncovered{color:#805c37}.segment-text{white-space:normal;overflow-wrap:anywhere}</style></head><body><main data-note-id="${escapeHtml(note.id)}"><h1>${escapeHtml(note.title)}</h1><p class="snapshot-kind">B 阅读快照 · 非可编辑 A 工程包</p>${note.tags.length ? `<p>${note.tags.map(escapeHtml).join(' · ')}</p>` : ''}${blocks}<section><h2>原稿引用</h2>${pages}</section></main></body></html>`;
}

function markdownText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
}
function codeFence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}math\n${text}\n${fence}`;
}

/** CommonMark with inline SVG references; plain Markdown viewers may choose not to render SVG. */
export function exportStructuredMarkdown(note: Note): string {
  const lines = [
    `# ${markdownText(note.title)}`,
    '',
    '> B 阅读快照；不包含可恢复编辑的 A 工程数据。',
    '',
    `<span data-note-id="${escapeHtml(note.id)}"></span>`,
    '',
  ];
  if (note.tags.length) lines.push(note.tags.map(markdownText).join(' · '), '');
  for (const block of note.blocks) {
    lines.push(
      `## ${markdownText(block.title)}`,
      '',
      `<a id="${safeId('block', block.id)}" data-block-id="${escapeHtml(block.id)}"></a>`,
      '',
    );
    for (const segment of block.segments.filter((segment) => !segment.deleted)) {
      lines.push(
        `<span id="${safeId('segment', segment.id)}" data-segment-id="${escapeHtml(segment.id)}" data-character-ids="${escapeHtml(JSON.stringify(segment.chars.filter((char) => !char.deleted).map((char) => char.id)))}"></span>`,
        '',
      );
      lines.push(
        segment.kind === 'formula' ? codeFence(segment.text) : markdownText(segment.text),
        '',
      );
      lines.push(
        `对应状态：${segment.source.status === 'exact' ? '已验证' : '未映射'} · ${segment.source.precision}`,
        '',
        `<span data-source-ids="${escapeHtml(JSON.stringify(segment.source.objectIds))}"></span>`,
        '',
      );
      if (segment.kind === 'reference' || segment.source.status !== 'exact')
        lines.push(sourceReferences(note, segment), '');
    }
    if (block.relatedBlockIds.length)
      lines.push(
        `知识关系：${block.relatedBlockIds.map((id) => markdownText(id)).join(' · ')}`,
        '',
      );
  }
  lines.push('## 原稿引用', '');
  for (const [index, page] of note.pages.entries())
    lines.push(`### 纸张 ${index + 1}`, '', pageSvg(page), '');
  return lines.join('\n');
}
