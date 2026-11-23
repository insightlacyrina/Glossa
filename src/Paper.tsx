import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { inkRadius, strokeOutline } from './ink';
import { SearchMark, type TextLocation } from './SearchMark';
import type { Bounds, Note, Page, PaperObject, Point } from './domain';
export type Tool = 'pen' | 'eraser' | 'select' | 'text' | 'formula';
export type StylusOptions = { barrelEraser: boolean; hoverCursor: boolean };
type Props = {
  note: Note;
  page: Page;
  tool: Tool;
  color: string;
  width: number;
  layer: string;
  editable: boolean;
  stylus?: StylusOptions;
  inputBlocked?: boolean;
  selected: string[];
  highlighted: string[];
  searchObject?: { id: string; location?: TextLocation };
  onSelect(ids: string[]): void;
  onStroke(points: Point[]): void;
  onDraft(points: Point[] | null): void;
  onErase(points: Point[], radius: number): void;
  onMove(ids: string[], dx: number, dy: number): void;
  onInsert(kind: 'text' | 'formula', at: { x: number; y: number }): void;
  onContext(object: PaperObject): void;
};
type Gesture = {
  pointerId: number;
  penContact: boolean;
  type: 'pen' | 'eraser' | 'select';
  start: Point;
  last: Point;
  points: Point[];
  color: string;
  width: number;
  outline: string;
  rendered: number;
  moving?: string[];
  contextTimer?: ReturnType<typeof setTimeout>;
  draftTimer?: ReturnType<typeof setTimeout>;
  draft: Props['onDraft'];
  commit: Props['onStroke'];
};
type TouchGesture = {
  pointerId: number;
  x: number;
  y: number;
  lastY: number;
  panning: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const ERASER_RADIUS = 14;
const BARREL_BUTTON = 2;
const ERASER_BUTTON = 32;
const PEN_CONTACT = 1 | ERASER_BUTTON;
const selectionBounds = ({ start, last }: Gesture): Bounds => ({
  x: Math.min(start.x, last.x),
  y: Math.min(start.y, last.y),
  width: Math.abs(last.x - start.x),
  height: Math.abs(last.y - start.y),
});
const intersects = (a: Bounds, b: Bounds) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;

const charcoalPaper = [37, 35, 32]; // --theme-paper in theme.css
const warmWhite = [245, 240, 232];
function luminance(channels: number[]) {
  const [r, g, b] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const paperLuminance = luminance(charcoalPaper);

function darkPaperInk(color: string) {
  if (!/^#(?:[a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color)) return 'var(--ink)';
  const hex = color.slice(1);
  const bytes = hex.length <= 4 ? [...hex].map((digit) => digit + digit) : hex.match(/../g)!;
  const [r, g, b, alpha = 255] = bytes.map((byte) => Number.parseInt(byte, 16));
  const rgb = [r, g, b];
  const opacity = alpha / 255;
  const hasContrast = (channels: number[]) => {
    const composite = channels.map(
      (channel, i) => channel * opacity + charcoalPaper[i] * (1 - opacity),
    );
    return (luminance(composite) + 0.05) / (paperLuminance + 0.05) >= 4.5;
  };
  if (hasContrast(rgb)) return color;

  // Present dark graphite as warm white. For colored ink use the first
  // readable tint, keeping the saved hue and transparency available on export.
  const graphite = Math.max(...rgb) < 105 && Math.max(...rgb) - Math.min(...rgb) <= 18;
  let visible = warmWhite;
  if (!graphite) {
    for (let step = 1; step < 10; step++) {
      const tint = rgb.map((channel, i) =>
        Math.round(channel + ((warmWhite[i] - channel) * step) / 10),
      );
      if (hasContrast(tint)) {
        visible = tint;
        break;
      }
    }
  }
  return `rgba(${visible.join(', ')}, ${opacity})`;
}

export function visibleObjects(page: Page) {
  const live = page.objects.filter((o) => !o.deleted);
  const replaced = new Set(
    live.filter((o) => o.revisionId).flatMap((o) => o.replacesObjectIds ?? []),
  );
  return live.filter((o) => !replaced.has(o.id));
}
export const ObjectView = memo(function ObjectView({
  object: o,
  searchLocation,
}: {
  object: PaperObject;
  searchLocation?: TextLocation;
}) {
  const outline = useMemo(
    () => (o.kind === 'stroke' && o.points ? strokeOutline(o.points, o.width ?? 2) : ''),
    [o.kind, o.points, o.width],
  );
  if (o.kind === 'stroke' && o.points)
    return (
      <path
        d={outline}
        fill={o.color ?? '#39353b'}
        fillRule="nonzero"
        data-ink-stroke={o.id}
        style={{ '--paper-ink-dark': darkPaperInk(o.color ?? '#39353b') } as CSSProperties}
      />
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
        style={
          {
            fontSize,
            lineHeight: 1.55,
            '--paper-ink-light': o.color,
            '--paper-ink-dark': o.color ? darkPaperInk(o.color) : undefined,
          } as CSSProperties
        }
      >
        <SearchMark text={o.text ?? '原生对象'} location={searchLocation} />
      </div>
    </foreignObject>
  );
});
export function PaperPreview({
  page,
  objectIds,
  minimumScale,
}: {
  page: Page;
  objectIds?: string[];
  minimumScale?: number;
}) {
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
      style={minimumScale ? { minWidth: box.width * minimumScale } : undefined}
    >
      <rect {...box} fill="var(--paper, #fbf9f2)" />
      {obs.map((o) => (
        <ObjectView key={o.id} object={o} />
      ))}
    </svg>
  );
}
export function Paper(props: Props) {
  const { page, tool, editable, selected, highlighted, stylus, inputBlocked } = props;
  const svg = useRef<SVGSVGElement>(null);
  const preview = useRef<SVGPathElement>(null);
  const hover = useRef<SVGCircleElement>(null);
  const active = useRef<Gesture | null>(null);
  const touch = useRef<TouchGesture | null>(null);
  const penNearby = useRef<number | null>(null);
  const barrelHover = useRef<number | null>(null);
  const frame = useRef(0);
  const [box, setBox] = useState<Bounds | null>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const objects = useMemo(() => visibleObjects(page), [page]);

  function point(e: React.PointerEvent<SVGSVGElement> | PointerEvent, rect: DOMRect): Point {
    return {
      x: ((e.clientX - rect.left) * page.width) / rect.width,
      y: ((e.clientY - rect.top) * page.height) / rect.height,
      pressure: e.pointerType === 'mouse' ? 0.5 : e.pressure,
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      time: e.timeStamp,
    };
  }

  function hitAt(p: Pick<Point, 'x' | 'y'>) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const object = objects[i];
      const { x, y, width, height } = object.bounds;
      if (p.x >= x - 5 && p.x <= x + width + 5 && p.y >= y - 5 && p.y <= y + height + 5)
        return object;
    }
  }

  function clearTouch() {
    clearTimeout(touch.current?.timer);
    touch.current = null;
  }

  function hideHover() {
    hover.current?.setAttribute('visibility', 'hidden');
  }

  function effectiveTool(e: React.PointerEvent<SVGSVGElement>) {
    if (
      stylus &&
      e.pointerType === 'pen' &&
      (e.buttons & ERASER_BUTTON ||
        e.button === 5 ||
        (stylus.barrelEraser && e.buttons & BARREL_BUTTON))
    )
      return 'eraser';
    return tool;
  }

  function hoverAt(e: React.PointerEvent<SVGSVGElement>) {
    if (!stylus || !editable || inputBlocked || e.pointerType !== 'pen') return;
    penNearby.current = e.pointerId;
    if (!(e.buttons & PEN_CONTACT))
      barrelHover.current = e.buttons & BARREL_BUTTON ? e.pointerId : null;
    clearTouch();
    const kind = effectiveTool(e);
    const cursor = hover.current;
    if (
      !stylus.hoverCursor ||
      active.current ||
      e.buttons & PEN_CONTACT ||
      (kind !== 'pen' && kind !== 'eraser') ||
      !cursor
    ) {
      hideHover();
      return;
    }
    const rect = svg.current!.getBoundingClientRect();
    const p = point(e, rect);
    cursor.setAttribute('cx', String(p.x));
    cursor.setAttribute('cy', String(p.y));
    cursor.setAttribute(
      'r',
      String(
        kind === 'eraser'
          ? ERASER_RADIUS
          : Math.max(inkRadius(props.width, 0.5), (3 * page.width) / rect.width),
      ),
    );
    cursor.setAttribute('data-tool', kind);
    cursor.setAttribute('visibility', 'visible');
  }

  function paint() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const a = active.current;
      const path = preview.current;
      if (!path || !a || a.type === 'select' || a.rendered === a.points.length) return;
      if (a.type === 'pen') {
        // A one-point dot is replaced by the first capsule. Subsequent frames only
        // build new capsules, with one overlapping sample to connect the batches.
        const start = a.rendered > 1 ? a.rendered - 1 : 0;
        a.outline = (start ? a.outline : '') + strokeOutline(a.points.slice(start), a.width);
      } else {
        const first = a.points[0];
        if (a.rendered <= 1) a.outline = `M${first.x},${first.y}`;
        for (let i = Math.max(1, a.rendered); i < a.points.length; i++) {
          const p = a.points[i];
          a.outline += `L${p.x},${p.y}`;
        }
        if (a.points.length === 1) a.outline += `L${first.x},${first.y}`;
      }
      a.rendered = a.points.length;
      path.setAttribute('d', a.outline);
      const fill = a.type === 'pen' ? a.color : 'none';
      if (path.getAttribute('fill') !== fill) {
        path.setAttribute('fill', fill);
        path.style.setProperty(
          '--paper-ink-dark',
          a.type === 'pen' ? darkPaperInk(a.color) : 'none',
        );
      }
      path.setAttribute('stroke', a.type === 'eraser' ? 'var(--theme-eraser, #b5aab780)' : 'none');
    });
  }

  function removeActive() {
    const a = active.current;
    active.current = null;
    if (a) {
      clearTimeout(a.contextTimer);
      clearTimeout(a.draftTimer);
    }
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    preview.current?.setAttribute('d', '');
    return a;
  }

  function resetSelectionPreview() {
    setBox(null);
    setShift({ x: 0, y: 0 });
  }

  function discardActive() {
    const a = removeActive();
    if (a?.type === 'pen') a.draft(null);
    if (a?.type === 'select') resetSelectionPreview();
  }

  useEffect(() => {
    function clearProximity() {
      penNearby.current = null;
      barrelHover.current = null;
      hideHover();
    }
    function blur() {
      clearTouch();
      clearProximity();
    }
    window.addEventListener('blur', blur);
    window.addEventListener('glossa-stylus-hover-exit', clearProximity);
    return () => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('glossa-stylus-hover-exit', clearProximity);
      blur();
      const a = removeActive();
      // An intentional page/view change ends this gesture. If the renderer
      // crashes, no cleanup runs and the durable checkpoint can be recovered.
      if (a?.type === 'pen') a.draft(null);
    };
  }, []);

  useEffect(() => {
    if (!inputBlocked) return;
    clearTouch();
    discardActive();
    penNearby.current = null;
    barrelHover.current = null;
    hideHover();
  }, [inputBlocked]);

  const barrelEraser = stylus?.barrelEraser;
  useEffect(() => {
    const element = svg.current;
    const native = window.QuietPaperNative;
    if (
      !element ||
      !native?.setStylusPaperBounds ||
      barrelEraser === undefined ||
      !editable ||
      inputBlocked
    )
      return;
    let pending = 0;
    let previous = '';
    const publish = () => {
      pending = 0;
      const { left, top, right, bottom } = element.getBoundingClientRect();
      const scale = window.devicePixelRatio;
      const bounds = [left, top, right, bottom].map((value) => Math.round(value * scale));
      const signature = bounds.join(',');
      if (signature === previous) return;
      previous = signature;
      native.setStylusPaperBounds!(bounds[0], bounds[1], bounds[2], bounds[3], barrelEraser);
    };
    const update = () => {
      if (!pending) pending = requestAnimationFrame(publish);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(document.body);
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);
    publish();
    return () => {
      cancelAnimationFrame(pending);
      observer.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      native.setStylusPaperBounds!(0, 0, 0, 0, false);
    };
  }, [barrelEraser, editable, inputBlocked, page.id]);

  function begin(e: React.PointerEvent<SVGSVGElement>, p: Point) {
    const type = effectiveTool(e);
    const penContact = !!stylus && e.pointerType === 'pen';
    const hit =
      !editable || type === 'select' || (type === 'pen' && !penContact) ? hitAt(p) : undefined;
    if (!editable) {
      if (hit) props.onContext(hit);
      return;
    }
    if (type === 'text' || type === 'formula') {
      props.onInsert(type, p);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const a: Gesture = {
      pointerId: e.pointerId,
      penContact,
      type,
      start: p,
      last: p,
      points: [p],
      color: props.color,
      width: props.width,
      outline: '',
      rendered: 0,
      draft: props.onDraft,
      commit: props.onStroke,
    };
    active.current = a;
    if (type === 'select') {
      if (hit) {
        a.moving = selected.includes(hit.id) ? selected : [hit.id];
        props.onSelect(a.moving);
      } else {
        props.onSelect([]);
        setBox(selectionBounds(a));
      }
    } else {
      hideHover();
      paint();
      if (type === 'pen') a.draft([p]);
    }
    if (hit && (type === 'select' || type === 'pen')) {
      a.contextTimer = setTimeout(() => {
        if (active.current !== a) return;
        discardActive();
        props.onContext(hit);
      }, 550);
    }
  }

  function down(e: React.PointerEvent<SVGSVGElement>) {
    if (inputBlocked) return;
    const rect = svg.current!.getBoundingClientRect();
    const p = point(e, rect);
    if (e.pointerType === 'touch' && (window.QuietPaperNative || !editable)) {
      const alreadyTouching = touch.current !== null;
      clearTouch();
      if (active.current || penNearby.current !== null || alreadyTouching || !e.isPrimary) return;
      const gesture: TouchGesture = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        lastY: e.clientY,
        panning: false,
      };
      touch.current = gesture;
      const hit = hitAt(p);
      if (hit) {
        gesture.timer = setTimeout(() => {
          if (touch.current !== gesture) return;
          clearTouch();
          props.onContext(hit);
        }, 500);
      }
      return;
    }
    if (active.current || !editable) return;
    if (stylus && e.pointerType === 'pen') {
      hoverAt(e);
      if (!(e.buttons & PEN_CONTACT) && e.button !== 5) return;
    } else if (e.button !== 0) return;
    begin(e, p);
  }

  function finish(e: React.PointerEvent<SVGSVGElement>, p: Point) {
    if (active.current?.pointerId !== e.pointerId) return;
    const a = removeActive()!;
    // A release can be the first event carrying the final position.
    if (p.x !== a.last.x || p.y !== a.last.y) a.points.push(p);
    a.last = p;
    if (a.type === 'pen') a.commit(a.points);
    else if (a.type === 'eraser') props.onErase(a.points, ERASER_RADIUS);
    else if (a.moving) {
      const dx = p.x - a.start.x;
      const dy = p.y - a.start.y;
      if (Math.hypot(dx, dy) > 1) props.onMove(a.moving, dx, dy);
    } else {
      const bounds = selectionBounds(a);
      props.onSelect(objects.filter((o) => intersects(o.bounds, bounds)).map((o) => o.id));
    }
    if (a.type === 'select') resetSelectionPreview();
    hoverAt(e);
  }

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const finger = touch.current;
    if (finger?.pointerId === e.pointerId) {
      if (Math.hypot(e.clientX - finger.x, e.clientY - finger.y) >= 8) {
        clearTimeout(finger.timer);
        if (stylus) finger.panning = true;
      }
      // Keeping touch-action:none protects vertical pen strokes from WebView
      // scroll cancellation. Only the owned finger gesture scrolls the paper.
      if (finger.panning) {
        window.scrollBy(0, finger.lastY - e.clientY);
        finger.lastY = e.clientY;
      }
      return;
    }
    const a = active.current;
    if (a?.pointerId !== e.pointerId) {
      if (!a && e.pointerType === 'pen') {
        hoverAt(e);
        // With a button already held in hover, tip contact can arrive as a
        // pointermove rather than a second pointerdown.
        if (barrelHover.current === e.pointerId && e.buttons & PEN_CONTACT)
          begin(e, point(e, svg.current!.getBoundingClientRect()));
      }
      return;
    }
    const rect = svg.current!.getBoundingClientRect();
    if (a.penContact && !(e.buttons & PEN_CONTACT)) {
      finish(e, point(e, rect));
      return;
    }
    const coalesced = e.nativeEvent.getCoalescedEvents?.();
    const samples = coalesced?.length
      ? coalesced.map((sample) => point(sample, rect))
      : [point(e, rect)];
    a.last = samples.at(-1)!;
    if (a.contextTimer && samples.some((p) => Math.hypot(p.x - a.start.x, p.y - a.start.y) >= 4)) {
      clearTimeout(a.contextTimer);
      a.contextTimer = undefined;
    }
    if (a.type === 'select') {
      if (a.moving) setShift({ x: a.last.x - a.start.x, y: a.last.y - a.start.y });
      else setBox(selectionBounds(a));
      return;
    }
    a.points.push(...samples);
    paint();
    if (a.type === 'pen' && !a.draftTimer) {
      a.draftTimer = setTimeout(() => {
        a.draftTimer = undefined;
        // Snapshot stays equal to the saved checkpoint until it is consumed.
        if (active.current === a) a.draft(a.points.slice());
      }, 220);
    }
  }

  function up(e: React.PointerEvent<SVGSVGElement>) {
    if (touch.current?.pointerId === e.pointerId) clearTouch();
    if (barrelHover.current === e.pointerId) barrelHover.current = null;
    if (active.current?.pointerId === e.pointerId)
      finish(e, point(e, svg.current!.getBoundingClientRect()));
    else hoverAt(e);
  }

  function cancel(e: React.PointerEvent<SVGSVGElement>) {
    if (touch.current?.pointerId === e.pointerId) clearTouch();
    if (active.current?.pointerId === e.pointerId) discardActive();
    if (barrelHover.current === e.pointerId) barrelHover.current = null;
    if (penNearby.current === e.pointerId) {
      penNearby.current = null;
      hideHover();
    }
  }
  return (
    <svg
      ref={svg}
      className={`paper-sheet tool-${tool}`}
      viewBox={`0 0 ${page.width} ${page.height}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onLostPointerCapture={(e) => {
        if (active.current?.pointerId === e.pointerId || touch.current?.pointerId === e.pointerId)
          cancel(e);
      }}
      onPointerEnter={hoverAt}
      onPointerLeave={(e) => {
        if (penNearby.current === e.pointerId) {
          penNearby.current = null;
          hideHover();
        }
        if (barrelHover.current === e.pointerId && !active.current) barrelHover.current = null;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (editable || inputBlocked || (e.nativeEvent as PointerEvent).pointerType === 'touch')
          return;
        const rect = svg.current!.getBoundingClientRect();
        const hit = hitAt({
          x: ((e.clientX - rect.left) * page.width) / rect.width,
          y: ((e.clientY - rect.top) * page.height) / rect.height,
        });
        if (hit) props.onContext(hit);
      }}
      aria-label={`原稿纸张 ${props.note.pages.indexOf(page) + 1}`}
      role="img"
    >
      <defs>
        <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="11" cy="11" r=".7" fill="var(--theme-paper-dot, #c9c4b7)" />
        </pattern>
        <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path
            d="M28 0H0V28"
            fill="none"
            stroke="var(--theme-paper-grid, #cfd6cf)"
            strokeWidth=".7"
          />
        </pattern>
        <pattern id="ruled" width="40" height="34" patternUnits="userSpaceOnUse">
          <path d="M0 33H10000" stroke="var(--theme-paper-grid, #d9dbd2)" strokeWidth=".8" />
        </pattern>
      </defs>
      <rect width={page.width} height={page.height} fill="var(--paper, #fbf9f2)" />
      {page.template !== 'blank' && (
        <rect
          width={page.width}
          height={page.height}
          fill={`url(#${page.template === 'dot' ? 'dots' : page.template})`}
        />
      )}
      {objects.map((o) => (
        <g
          key={o.id}
          id={props.searchObject?.id === o.id ? `paper-object-${o.id}` : undefined}
          transform={selected.includes(o.id) ? `translate(${shift.x},${shift.y})` : undefined}
        >
          <ObjectView
            object={o}
            searchLocation={
              props.searchObject?.id === o.id ? props.searchObject.location : undefined
            }
          />
          {(selected.includes(o.id) || highlighted.includes(o.id)) && (
            <rect
              x={o.bounds.x - 5}
              y={o.bounds.y - 5}
              width={o.bounds.width + 10}
              height={o.bounds.height + 10}
              fill={
                highlighted.includes(o.id)
                  ? 'var(--theme-paper-highlight, #a6b49422)'
                  : 'var(--theme-paper-selection, #74708b10)'
              }
              stroke={
                highlighted.includes(o.id)
                  ? 'var(--theme-success, #7d8f69)'
                  : 'var(--theme-accent, #8f8196)'
              }
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
          )}
          {o.revisionId && (
            <path
              d={`M${o.bounds.x - 12} ${o.bounds.y}v${Math.max(24, o.bounds.height)}`}
              stroke="var(--theme-warning, #a67d54)"
              strokeWidth="3"
            />
          )}
        </g>
      ))}
      <path
        ref={preview}
        d=""
        fillRule="nonzero"
        strokeWidth={ERASER_RADIUS * 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
        aria-hidden="true"
        data-ink-preview=""
      />
      {stylus && (
        <circle
          ref={hover}
          className="paper-pen-hover"
          visibility="hidden"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
          aria-hidden="true"
          data-pen-hover=""
        />
      )}
      {box && (
        <rect
          {...box}
          fill="var(--theme-paper-selection, #9284961a)"
          stroke="var(--theme-accent, #86728a)"
          strokeDasharray="6 4"
        />
      )}
    </svg>
  );
}
