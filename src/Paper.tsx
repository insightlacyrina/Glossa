import { memo, useMemo, useRef, useState } from 'react';
import { strokeOutline } from './ink';
import type { Bounds, Note, Page, PaperObject, Point } from './domain';
export type Tool = 'pen' | 'eraser' | 'select' | 'text' | 'formula';
type Props = {
  note: Note;
  page: Page;
  tool: Tool;
  color: string;
  width: number;
  layer: string;
  editable: boolean;
  selected: string[];
  highlighted: string[];
  onSelect(ids: string[]): void;
  onStroke(points: Point[]): void;
  onDraft(points: Point[] | null): void;
  onErase(points: Point[], radius: number): void;
  onMove(ids: string[], dx: number, dy: number): void;
  onInsert(kind: 'text' | 'formula', at: { x: number; y: number }): void;
  onContext(object: PaperObject): void;
};
const intersects = (a: Bounds, b: Bounds) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
export function visibleObjects(page: Page) {
  const live = page.objects.filter((o) => !o.deleted);
  const replaced = new Set(
    live.filter((o) => o.revisionId).flatMap((o) => o.replacesObjectIds ?? []),
  );
  return live.filter((o) => !replaced.has(o.id));
}
export const ObjectView = memo(function ObjectView({ object: o }: { object: PaperObject }) {
  const outline = useMemo(
    () => (o.kind === 'stroke' && o.points ? strokeOutline(o.points, o.width ?? 2) : ''),
    [o.kind, o.points, o.width],
  );
  if (o.kind === 'stroke' && o.points)
    return (
      <path d={outline} fill={o.color ?? '#39353b'} fillRule="nonzero" data-ink-stroke={o.id} />
    );
  if (o.kind === 'image')
    return (
      <image
        href={o.data}
        x={o.bounds.x}
        y={o.bounds.y}
        width={o.bounds.width}
        height={o.bounds.height}
        preserveAspectRatio="xMidYMid meet"
      />
    );
  const fontSize =
    o.kind === 'formula'
      ? Math.min(32, o.bounds.height * 0.56)
      : Math.min(35, Math.max(14, o.bounds.height * 0.55));
  return (
    <foreignObject
      x={o.bounds.x}
      y={o.bounds.y}
      width={o.bounds.width}
      height={Math.max(o.bounds.height, 32)}
    >
      <div
        className={`paper-text ${o.kind === 'formula' ? 'math' : ''} ${o.revisionId ? 'revision-text' : ''}`}
        style={{ fontSize, lineHeight: 1.55, color: o.color }}
      >
        {o.text ?? '原生对象'}
      </div>
    </foreignObject>
  );
});
export function PaperPreview({ page, objectIds }: { page: Page; objectIds?: string[] }) {
  const obs = visibleObjects(page).filter((o) => !objectIds || objectIds.includes(o.id));
  const box =
    obs.length && objectIds
      ? {
          x: Math.min(...obs.map((o) => o.bounds.x)) - 15,
          y: Math.min(...obs.map((o) => o.bounds.y)) - 15,
          width:
            Math.max(...obs.map((o) => o.bounds.x + o.bounds.width)) -
            Math.min(...obs.map((o) => o.bounds.x)) +
            30,
          height:
            Math.max(...obs.map((o) => o.bounds.y + o.bounds.height)) -
            Math.min(...obs.map((o) => o.bounds.y)) +
            30,
        }
      : { x: 0, y: 0, width: page.width, height: page.height };
  return (
    <svg
      className="paper-preview"
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      aria-label="原始对象预览"
    >
      <rect {...box} fill="#fbf9f2" />
      {obs.map((o) => (
        <ObjectView key={o.id} object={o} />
      ))}
    </svg>
  );
}
export function Paper(props: Props) {
  const { page, tool, editable, selected, highlighted } = props;
  const svg = useRef<SVGSVGElement>(null);
  const touchPress = useRef<{ start: Point; timer: ReturnType<typeof setTimeout> } | null>(null);
  const active = useRef<{
    points: Point[];
    start: Point;
    type: Tool;
    moving?: string[];
    timer?: ReturnType<typeof setTimeout>;
    last: Point;
  } | null>(null);
  const [trail, setTrail] = useState<Point[]>([]);
  const [box, setBox] = useState<Bounds | null>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  function point(e: React.PointerEvent<SVGSVGElement> | PointerEvent): Point {
    const rect = svg.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * page.width) / rect.width,
      y: ((e.clientY - rect.top) * page.height) / rect.height,
      pressure: e.pointerType === 'mouse' ? 0.5 : e.pressure,
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
      time: e.timeStamp,
    };
  }
  function down(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0 || active.current) return;
    const p = point(e);
    const hit = [...visibleObjects(page)].reverse().find((o) =>
      intersects(
        {
          ...o.bounds,
          x: o.bounds.x - 5,
          y: o.bounds.y - 5,
          width: o.bounds.width + 10,
          height: o.bounds.height + 10,
        },
        { x: p.x, y: p.y, width: 1, height: 1 },
      ),
    );
    if (e.pointerType === 'touch') {
      if (hit)
        touchPress.current = {
          start: p,
          timer: setTimeout(() => {
            props.onContext(hit);
            touchPress.current = null;
          }, 500),
        };
      if (window.QuietPaperNative) return;
    }
    if (!editable) {
      if (hit) props.onContext(hit);
      return;
    }
    if (tool === 'text' || tool === 'formula') {
      props.onInsert(tool, p);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const type = tool;
    active.current = { points: [p], start: p, last: p, type };
    if (type === 'select') {
      if (hit) {
        const ids = selected.includes(hit.id) ? selected : [hit.id];
        props.onSelect(ids);
        active.current.moving = ids;
        active.current.timer = setTimeout(() => {
          if (
            active.current &&
            Math.hypot(active.current.last.x - p.x, active.current.last.y - p.y) < 5
          ) {
            props.onContext(hit);
            active.current = null;
            setShift({ x: 0, y: 0 });
          }
        }, 550);
      } else {
        props.onSelect([]);
        setBox({ x: p.x, y: p.y, width: 0, height: 0 });
      }
    } else {
      setTrail([p]);
      if (type === 'pen') {
        props.onDraft([p]);
        if (hit)
          active.current.timer = setTimeout(() => {
            if (
              active.current &&
              Math.hypot(active.current.last.x - p.x, active.current.last.y - p.y) < 5
            ) {
              active.current = null;
              setTrail([]);
              props.onDraft(null);
              props.onContext(hit);
            }
          }, 550);
      }
    }
  }
  function move(e: React.PointerEvent<SVGSVGElement>) {
    if (touchPress.current) {
      const p = point(e);
      if (Math.hypot(p.x - touchPress.current.start.x, p.y - touchPress.current.start.y) > 8) {
        clearTimeout(touchPress.current.timer);
        touchPress.current = null;
      }
    }
    const a = active.current;
    if (!a) return;
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const newPoints = samples.length ? samples.map(point) : [point(e)];
    a.last = newPoints.at(-1)!;
    if (a.type === 'select') {
      const dx = a.last.x - a.start.x,
        dy = a.last.y - a.start.y;
      if (Math.hypot(dx, dy) > 4 && a.timer) {
        clearTimeout(a.timer);
        a.timer = undefined;
      }
      if (a.moving) setShift({ x: dx, y: dy });
      else
        setBox({
          x: Math.min(a.start.x, a.last.x),
          y: Math.min(a.start.y, a.last.y),
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
    } else {
      if (Math.hypot(a.last.x - a.start.x, a.last.y - a.start.y) > 4 && a.timer) {
        clearTimeout(a.timer);
        a.timer = undefined;
      }
      a.points.push(...newPoints);
      setTrail([...a.points]);
      if (a.type === 'pen') props.onDraft(a.points);
    }
  }
  function up() {
    if (touchPress.current) {
      clearTimeout(touchPress.current.timer);
      touchPress.current = null;
    }
    const a = active.current;
    if (!a) return;
    active.current = null;
    if (a.timer) clearTimeout(a.timer);
    if (a.type === 'pen') props.onStroke(a.points);
    else if (a.type === 'eraser') props.onErase(a.points, 14);
    else if (a.moving) {
      const dx = a.last.x - a.start.x,
        dy = a.last.y - a.start.y;
      if (Math.hypot(dx, dy) > 1) props.onMove(a.moving, dx, dy);
    } else if (box)
      props.onSelect(
        visibleObjects(page)
          .filter((o) => intersects(o.bounds, box))
          .map((o) => o.id),
      );
    setTrail([]);
    setBox(null);
    setShift({ x: 0, y: 0 });
  }
  return (
    <svg
      ref={svg}
      className={`paper-sheet tool-${tool}`}
      viewBox={`0 0 ${page.width} ${page.height}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={`原稿纸张 ${props.note.pages.indexOf(page) + 1}`}
      role="img"
    >
      <defs>
        <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="11" cy="11" r=".7" fill="#c9c4b7" />
        </pattern>
        <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M28 0H0V28" fill="none" stroke="#cfd6cf" strokeWidth=".7" />
        </pattern>
        <pattern id="ruled" width="40" height="34" patternUnits="userSpaceOnUse">
          <path d="M0 33H10000" stroke="#d9dbd2" strokeWidth=".8" />
        </pattern>
      </defs>
      <rect width={page.width} height={page.height} fill="#fbf9f2" />
      {page.template !== 'blank' && (
        <rect
          width={page.width}
          height={page.height}
          fill={`url(#${page.template === 'dot' ? 'dots' : page.template})`}
        />
      )}
      {visibleObjects(page).map((o) => (
        <g
          key={o.id}
          transform={selected.includes(o.id) ? `translate(${shift.x},${shift.y})` : undefined}
        >
          <ObjectView object={o} />
          {(selected.includes(o.id) || highlighted.includes(o.id)) && (
            <rect
              x={o.bounds.x - 5}
              y={o.bounds.y - 5}
              width={o.bounds.width + 10}
              height={o.bounds.height + 10}
              fill={highlighted.includes(o.id) ? '#a6b49422' : '#74708b10'}
              stroke={highlighted.includes(o.id) ? '#7d8f69' : '#8f8196'}
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
          )}
          {o.revisionId && (
            <path
              d={`M${o.bounds.x - 12} ${o.bounds.y}v${Math.max(24, o.bounds.height)}`}
              stroke="#a67d54"
              strokeWidth="3"
            />
          )}
        </g>
      ))}
      {trail.length > 0 &&
        (tool === 'eraser' ? (
          <g stroke="#b5aab780" fill="none" strokeWidth="28" strokeLinecap="round">
            <path d={trail.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')} />
          </g>
        ) : (
          <path
            d={trail.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={props.color}
            strokeWidth={props.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      {box && <rect {...box} fill="#9284961a" stroke="#86728a" strokeDasharray="6 4" />}
    </svg>
  );
}
