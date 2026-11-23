import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';

type Anchor = { x: number; y: number; clientX: number; clientY: number };
type Tap = { x: number; y: number; at: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function ReadingPaper({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const anchor = useRef<Anchor | null>(null);

  function point(clientX: number, clientY: number): Anchor {
    const box = content.current!.getBoundingClientRect();
    return {
      x: (clientX - box.left) / box.width,
      y: (clientY - box.top) / box.height,
      clientX,
      clientY,
    };
  }

  function apply(next: number, focus: Anchor) {
    const value = clamp(next, 1, 4);
    anchor.current = focus;
    if (value === scaleRef.current) {
      positionContent();
      return;
    }
    scaleRef.current = value;
    setScale(value);
  }

  function positionContent() {
    const focus = anchor.current;
    if (!focus) return;
    anchor.current = null;
    const el = viewport.current!;
    const rect = el.getBoundingClientRect();
    el.scrollLeft =
      focus.x * content.current!.offsetWidth - clamp(focus.clientX - rect.left, 0, el.clientWidth);
    el.scrollTop =
      focus.y * content.current!.offsetHeight - clamp(focus.clientY - rect.top, 0, el.clientHeight);
  }

  useLayoutEffect(positionContent, [scale]);

  function byStep(factor: number) {
    const rect = viewport.current!.getBoundingClientRect();
    const y = (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2;
    apply(scaleRef.current * factor, point(rect.left + rect.width / 2, y));
  }

  useEffect(() => {
    const el = viewport.current!;
    let pinch: { distance: number; scale: number; anchor: Anchor } | null = null;
    let start: Tap | null = null;
    let lastTap: Tap | null = null;
    let lastTouchZoom = -Infinity;
    function pair(touches: TouchList) {
      const [a, b] = [touches[0], touches[1]];
      return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
        distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      };
    }
    function touchStart(event: TouchEvent) {
      if (event.touches.length === 1) {
        const touch = event.touches[0];
        start = { x: touch.clientX, y: touch.clientY, at: performance.now() };
      } else {
        start = lastTap = null;
        if (event.touches.length !== 2) return;
        if (event.cancelable) event.preventDefault();
        const { x, y, distance } = pair(event.touches);
        pinch = { distance, scale: scaleRef.current, anchor: point(x, y) };
      }
    }
    function touchMove(event: TouchEvent) {
      if (pinch && event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        const { x, y, distance } = pair(event.touches);
        apply((pinch.scale * distance) / pinch.distance, {
          ...pinch.anchor,
          clientX: x,
          clientY: y,
        });
      } else if (start && event.touches.length === 1) {
        const touch = event.touches[0];
        if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) start = null;
      }
    }
    function toggle(x: number, y: number) {
      apply(scaleRef.current > 1 ? 1 : 2.5, point(x, y));
    }
    function touchEnd(event: TouchEvent) {
      pinch = null;
      const tap = start;
      start = null;
      if (!tap || event.touches.length || performance.now() - tap.at > 270) return;
      if (
        lastTap &&
        tap.at - lastTap.at < 340 &&
        Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 30
      ) {
        if (event.cancelable) event.preventDefault();
        lastTouchZoom = performance.now();
        lastTap = null;
        toggle(tap.x, tap.y);
      } else lastTap = tap;
    }
    function cancel() {
      pinch = start = lastTap = null;
    }
    function doubleClick(event: MouseEvent) {
      if (performance.now() - lastTouchZoom < 450) return;
      toggle(event.clientX, event.clientY);
    }
    el.addEventListener('touchstart', touchStart, { passive: false });
    el.addEventListener('touchmove', touchMove, { passive: false });
    el.addEventListener('touchend', touchEnd, { passive: false });
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('dblclick', doubleClick);
    return () => {
      el.removeEventListener('touchstart', touchStart);
      el.removeEventListener('touchmove', touchMove);
      el.removeEventListener('touchend', touchEnd);
      el.removeEventListener('touchcancel', cancel);
      el.removeEventListener('dblclick', doubleClick);
    };
  }, []);

  return (
    <div className="reading-paper">
      <div className="reading-zoom" role="group" aria-label="原稿缩放">
        <button aria-label="缩小原稿" disabled={scale === 1} onClick={() => byStep(1 / 1.5)}>
          <Minus size={17} />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button aria-label="放大原稿" disabled={scale === 4} onClick={() => byStep(1.5)}>
          <Plus size={17} />
        </button>
        <button aria-label="适合宽度" disabled={scale === 1} onClick={() => apply(1, point(0, 0))}>
          <Maximize size={16} />
          <span>整页</span>
        </button>
      </div>
      <div
        ref={viewport}
        className="paper-frame reading-viewport"
        data-zoomed={scale > 1}
        tabIndex={scale > 1 ? 0 : undefined}
        aria-label={scale > 1 ? '已放大的原稿，可平移' : undefined}
      >
        <div ref={content} style={{ width: `${scale * 100}%` }}>
          {children}
        </div>
      </div>
    </div>
  );
}
