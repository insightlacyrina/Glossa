import type { RecognitionObject } from './automation';

export type RecognitionGroup = {
  id: string;
  objects: RecognitionObject[];
  objectIds: string[];
  sourceRevisions: Record<string, string | number>;
};
export type LocalRecognitionCandidate = {
  text: string;
  candidates?: string[];
  confidence?: number;
  engine?: string;
};
export type LocalRecognizer = (
  group: RecognitionGroup,
  signal: AbortSignal,
) => Promise<LocalRecognitionCandidate>;

type Box = { x: number; y: number; width: number; height: number };
function sourceBounds(object: RecognitionObject): Box | undefined {
  if (object.kind !== 'stroke') return object.bounds;
  const points = object.points;
  if (!points?.length || points.length > 200_000) return undefined;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const point of points) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      Math.abs(point.x) > 10_000_000 ||
      Math.abs(point.y) > 10_000_000
    )
      return undefined;
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
/** Nearby strokes form a candidate line; this grouping never claims a character mapping. */
export function groupRecognitionObjects(objects: RecognitionObject[]): RecognitionGroup[] {
  const groups: { objects: RecognitionObject[]; bounds?: Box; key: string; pointCount: number }[] =
    [];
  const order = new Map(objects.map((object, index) => [object, index]));
  for (const object of objects) {
    const bounds = sourceBounds(object);
    const key = JSON.stringify([object.noteId, object.pageId, object.recognitionScope]);
    const matches =
      object.kind === 'stroke' && bounds
        ? groups.filter((candidate) => {
            if (
              candidate.key !== key ||
              candidate.objects[0].kind !== 'stroke' ||
              !candidate.bounds ||
              candidate.objects.length >= 256 ||
              candidate.pointCount + (object.points?.length ?? 0) > 200_000
            )
              return false;
            const other = candidate.bounds;
            const verticalGap = Math.max(
              bounds.y - other.y - other.height,
              other.y - bounds.y - bounds.height,
              0,
            );
            const horizontalGap = Math.max(
              bounds.x - other.x - other.width,
              other.x - bounds.x - bounds.width,
              0,
            );
            // Small dot/horizontal strokes may belong to a taller adjacent character.
            const lineHeight = Math.max(16, Math.min(100, Math.max(bounds.height, other.height)));
            return (
              verticalGap <= Math.min(12, lineHeight * 0.3) &&
              horizontalGap <= Math.max(48, lineHeight * 2)
            );
          })
        : [];
    let group = matches[0];
    if (group) {
      for (const neighbor of matches.slice(1)) {
        if (
          group.objects.length + neighbor.objects.length + 1 > 256 ||
          group.pointCount + neighbor.pointCount + (object.points?.length ?? 0) > 200_000
        )
          continue;
        group.objects.push(...neighbor.objects);
        group.pointCount += neighbor.pointCount;
        group.bounds = union(group.bounds!, neighbor.bounds!);
        groups.splice(groups.indexOf(neighbor), 1);
      }
    }
    if (!group) {
      group = { objects: [], bounds, key, pointCount: 0 };
      groups.push(group);
    }
    group.objects.push(object);
    group.pointCount += object.points?.length ?? 0;
    if (bounds && group.bounds) group.bounds = union(group.bounds, bounds);
  }
  for (const group of groups) group.objects.sort((a, b) => order.get(a)! - order.get(b)!);
  return groups.map(({ objects: members }) => ({
    id: members[0].id,
    objects: members,
    objectIds: members.map((object) => object.id),
    sourceRevisions: Object.fromEntries(members.map((object) => [object.id, object.revision])),
  }));
}

export function validateLocalCandidate(
  value: LocalRecognitionCandidate,
): LocalRecognitionCandidate {
  if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 100_000)
    throw new Error('识别未返回可用文字；请保留原稿并手工校对');
  if (
    value.confidence !== undefined &&
    (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)
  )
    throw new Error('识别置信度格式无效');
  return {
    text: value.text,
    ...(value.confidence !== undefined ? { confidence: value.confidence } : {}),
    candidates: [
      ...new Set([
        value.text,
        ...(value.candidates ?? []).filter(
          (item) => typeof item === 'string' && item.length <= 100_000,
        ),
      ]),
    ].slice(0, 8),
    engine: typeof value.engine === 'string' ? value.engine : undefined,
  };
}

/** Rasterize real visual input for vision models; never send raw point JSON as a photograph. */
export async function rasterizeRecognitionGroup(
  group: RecognitionGroup,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (typeof document === 'undefined') throw new Error('当前环境无法生成识别图像');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建识别图像');
  if (group.objects.length === 1 && group.objects[0].kind === 'image') {
    const data = group.objects[0].data;
    if (
      !data ||
      data.length > 14_000_000 ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)
    )
      throw new Error('识别仅接受本机 PNG/JPEG/WebP 图片');
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      const abort = () => {
        image.src = '';
        reject(signal.reason ?? new Error('识别已取消'));
      };
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      image.onerror = () => {
        signal.removeEventListener('abort', abort);
        reject(new Error('图片无法解码'));
      };
      image.src = data;
    });
    await loaded;
    signal.throwIfAborted();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效');
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  } else {
    const boxes = group.objects.map(sourceBounds);
    if (
      boxes.some((box) => !box) ||
      group.objects.some((object) => object.kind !== 'stroke' || !object.points?.length)
    )
      throw new Error('没有可供识别的有效笔迹图像');
    const bounds = (boxes as Box[]).reduce(union);
    const padding = 12;
    const width = bounds.width + padding * 2,
      height = bounds.height + padding * 2;
    const scale = Math.min(3, 2048 / Math.max(width, height));
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.translate(padding - bounds.x, padding - bounds.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const object of group.objects) {
      signal.throwIfAborted();
      const points = object.points!;
      ctx.strokeStyle = '#202020';
      ctx.fillStyle = '#202020';
      const width =
        Number.isFinite(object.width) && object.width! > 0 ? Math.min(30, object.width!) : 2;
      if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1],
          point = points[index];
        ctx.lineWidth = width * (0.35 + Math.max(0, Math.min(1, point.pressure ?? 0.5)) * 0.9);
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
    }
  }
  signal.throwIfAborted();
  return canvas.toDataURL('image/png');
}
