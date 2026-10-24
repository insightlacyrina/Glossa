import { useEffect, useRef } from 'react';

type BackHandler = () => boolean | void;
type BackEntry = {
  id: symbol;
  priority: number;
  order: number;
  enabled: { current: boolean };
  handler: { current: BackHandler };
};
const handlers = new Map<symbol, BackEntry>();
let order = 0;
function activeHandlers() {
  return [...handlers.values()]
    .filter((entry) => entry.enabled.current)
    .sort((a, b) => b.priority - a.priority || b.order - a.order);
}

/** The highest visible layer handles Back; only an explicit false falls through. */
export function dispatchBackHandlers(): boolean {
  for (const entry of activeHandlers()) {
    try {
      if (entry.handler.current() !== false) return true;
    } catch (error) {
      // A failing close handler must not dismiss the layer underneath it.
      console.error('Unable to close the current view', error);
      return true;
    }
  }
  return false;
}

/** Returns a live top-layer check for local focus traps; callers may ignore it. */
export function useBackHandler(enabled: boolean, handler: BackHandler, priority: number) {
  const id = useRef(Symbol('back-layer'));
  const enabledRef = useRef(enabled),
    handlerRef = useRef(handler);
  enabledRef.current = enabled;
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const key = id.current;
    handlers.set(key, {
      id: key,
      priority,
      order: ++order,
      enabled: enabledRef,
      handler: handlerRef,
    });
    return () => {
      handlers.delete(key);
    };
  }, [enabled, priority]);
  return () => activeHandlers()[0]?.id === id.current;
}

function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  if (dispatchBackHandlers()) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
if (typeof document !== 'undefined') document.addEventListener('keydown', escape, true);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (typeof document !== 'undefined') document.removeEventListener('keydown', escape, true);
  });
}
