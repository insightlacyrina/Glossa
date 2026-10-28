import type { Bounds, PaperObject, Point } from './domain';

/** A confirmed character made from actual pen samples, never an inferred OCR glyph. */
export type HandwritingGlyph = {
  id: string;
  character: string;
  noteId: string;
  pageId: string;
  sourceVersions: Record<string, string>;
  height: number;
  aspect: number;
  strokes: { points: Point[]; width: number; color: string }[];
};

export function validHandwritingCharacter(character: unknown): character is string {
  return (
    typeof character === 'string' &&
    Array.from(character).length === 1 &&
    !/[\s\p{Cc}\p{Cf}\p{M}]/u.test(character) &&
    !/[\uD800-\uDFFF]/u.test(character)
  );
}

export function captureHandwritingGlyph(
  character: string,
  noteId: string,
  source: PaperObject[],
): Omit<HandwritingGlyph, 'id'> {
  if (!validHandwritingCharacter(character))
    throw new Error('请确认一个非空白字符；组合字符暂不支持');
  if (
    !source.length ||
    source.length > 128 ||
    new Set(source.map((o) => o.id)).size !== source.length ||
    source.some((o) => o.deleted || o.revisionId || o.kind !== 'stroke' || !o.points?.length) ||
    new Set(source.map((o) => o.pageId)).size !== 1
  )
    throw new Error('字形样本必须是同页的原始笔迹');
  const points = source.flatMap((o) => o.points!);
  if (
    points.length > 50000 ||
    points.some(
      (p) =>
        !['x', 'y', 'pressure', 'tiltX', 'tiltY', 'time'].every((k) =>
          Number.isFinite(p[k as keyof Point]),
        ) ||
        p.pressure < 0 ||
        p.pressure > 1,
    )
  )
    throw new Error('字形笔迹样本无效或过大');
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  const width = Math.max(1, right - left),
    height = Math.max(8, bottom - top, width * 0.65);
  if (height > 20000 || width > 20000) throw new Error('字形尺寸超出范围');
  return {
    character,
    noteId,
    pageId: source[0].pageId,
    sourceVersions: Object.fromEntries(source.map((o) => [o.id, o.version])),
    height,
    aspect: width / height,
    strokes: source.map((o) => ({
      width: (o.width ?? 2.4) / height,
      color: o.color ?? '#302d36',
      points: o.points!.map((p) => ({ ...p, x: (p.x - left) / height, y: (p.y - top) / height })),
    })),
  };
}

export function validateHandwritingGlyph(
  glyph: unknown,
): asserts glyph is Omit<HandwritingGlyph, 'id'> {
  const g = glyph as HandwritingGlyph;
  if (
    !g ||
    !validHandwritingCharacter(g.character) ||
    typeof g.noteId !== 'string' ||
    typeof g.pageId !== 'string' ||
    !Number.isFinite(g.height) ||
    g.height < 1 ||
    g.height > 20000 ||
    !Number.isFinite(g.aspect) ||
    g.aspect <= 0 ||
    g.aspect > 20000 ||
    !g.sourceVersions ||
    typeof g.sourceVersions !== 'object' ||
    Array.isArray(g.sourceVersions) ||
    !Object.keys(g.sourceVersions).length ||
    Object.keys(g.sourceVersions).length > 128 ||
    Object.entries(g.sourceVersions).some(
      ([id, version]) => !id || typeof version !== 'string' || !version,
    ) ||
    !Array.isArray(g.strokes) ||
    !g.strokes.length ||
    g.strokes.length > 128 ||
    g.strokes.some(
      (s) =>
        !s ||
        typeof s.color !== 'string' ||
        !Number.isFinite(s.width) ||
        s.width <= 0 ||
        s.width > 100 ||
        !Array.isArray(s.points) ||
        !s.points.length ||
        s.points.some(
          (p) =>
            !p ||
            !['x', 'y', 'pressure', 'tiltX', 'tiltY', 'time'].every((k) =>
              Number.isFinite(p[k as keyof Point]),
            ) ||
            p.x < -0.001 ||
            p.x > g.aspect + 0.001 ||
            p.y < -0.001 ||
            p.y > 1.001 ||
            p.pressure < 0 ||
            p.pressure > 1,
        ),
    ) ||
    g.strokes.reduce((n, s) => n + s.points.length, 0) > 50000
  )
    throw new Error('Invalid handwriting glyph');
}

export type HandwritingOutput = {
  strokes: {
    points: Point[];
    width: number;
    color: string;
    characterIndex: number;
    sampleId: string;
  }[];
  sampleIds: string[];
  reason?: string;
  missing: string[];
};

/** Compose confirmed vector glyphs deterministically, preserving every pen channel. */
export function composeHandwriting(
  text: string,
  bounds: Bounds,
  glyphs: HandwritingGlyph[],
): HandwritingOutput {
  const failure = (reason: string, missing: string[] = []): HandwritingOutput => ({
    strokes: [],
    sampleIds: [],
    reason,
    missing,
  });
  const chars = Array.from(text);
  if (!chars.length || chars.length > 4000) return failure('文字为空或过长，保留印刷层');
  const library = new Map<string, HandwritingGlyph>();
  for (const g of glyphs) library.set(g.character, g);
  const missing = [...new Set(chars.filter((c) => !/[\s]/u.test(c) && !library.has(c)))];
  if (missing.length)
    return failure(`缺少已确认字形：${missing.slice(0, 20).join('')}；保留可编辑印刷层`, missing);
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width < 1 ||
    bounds.height < 1
  )
    return failure('原稿位置无效，保留印刷层');
  const used = chars.map((c) => library.get(c)).filter((g): g is HandwritingGlyph => !!g);
  if (!used.length) return failure('空白文字保留可编辑印刷层');
  const sizes = used.map((g) => g.height).sort((a, b) => a - b);
  const naturalSize = Math.max(8, Math.min(128, sizes[Math.floor(sizes.length / 2)]));
  type Slot = { glyph: HandwritingGlyph; x: number; y: number; index: number };
  let slots: Slot[] = [],
    chosenSize = naturalSize;
  for (let shrink = 0; shrink <= 7; shrink++) {
    const size = naturalSize * (1 - shrink * 0.05),
      gap = size * 0.16,
      lineHeight = size * 1.35;
    let x = 0,
      y = 0;
    const trial: Slot[] = [];
    let fits = true;
    for (const [index, char] of chars.entries()) {
      if (char === '\n' || char === '\r') {
        if (char === '\n') {
          x = 0;
          y += lineHeight;
        }
        continue;
      }
      if (/\s/u.test(char)) {
        x += size * (char === '\t' ? 1.4 : 0.4);
        continue;
      }
      const glyph = library.get(char)!,
        width = glyph.aspect * size;
      if (x > 0 && x + width > bounds.width) {
        x = 0;
        y += lineHeight;
      }
      if (width > bounds.width || y + size > bounds.height) {
        fits = false;
        break;
      }
      trial.push({ glyph, x, y, index });
      x += Math.max(width, size * 0.2) + gap;
    }
    if (fits) {
      slots = trial;
      chosenSize = size;
      break;
    }
  }
  if (!slots.length) return failure('原位置无法容纳仿手写，保留印刷层；请调整原稿位置后重试');
  const count = slots.reduce(
    (n, slot) => n + slot.glyph.strokes.reduce((n, s) => n + s.points.length, 0),
    0,
  );
  if (count > 150000 || slots.reduce((n, slot) => n + slot.glyph.strokes.length, 0) > 4000)
    return failure('仿手写笔迹数量超出范围，保留印刷层');
  return {
    strokes: slots.flatMap(({ glyph, x, y, index }) =>
      glyph.strokes.map((s) => ({
        points: s.points.map((p) => ({
          ...p,
          x: bounds.x + x + p.x * chosenSize,
          y: bounds.y + y + p.y * chosenSize,
        })),
        width: s.width * chosenSize,
        color: s.color,
        characterIndex: index,
        sampleId: glyph.id,
      })),
    ),
    sampleIds: [...new Set(slots.map((s) => s.glyph.id))],
    missing: [],
  };
}
