import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useBackHandler } from './ui-navigation';

export function inputState(element: HTMLElement) {
  return JSON.stringify(
    Array.from(
      element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input,textarea,select',
      ),
    ).map((input) => [
      input.name,
      input.value,
      input instanceof HTMLInputElement ? input.checked : null,
    ]),
  );
}

/** Closing a view never acts as submitting its unfinished form. */
export function DialogShell({
  title,
  wide,
  children,
  error,
  onClose,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
  error?: string;
  onClose(): void;
}) {
  const container = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const baseline = useRef('');
  const dirty = useRef(false);
  const close = () => {
    const forms = Array.from(
      container.current?.querySelectorAll<HTMLFormElement>('form[data-dirty]') ?? [],
    );
    const changed = forms.length
      ? forms.some((form) => form.dataset.dirty === 'true')
      : dirty.current;
    if (changed && !window.confirm('尚有未保存的输入，放弃这些输入并关闭？')) return;
    onClose();
  };
  const isTop = useBackHandler(true, close, 100);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(backdrop.current?.parentElement?.children ?? []).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== backdrop.current,
    );
    const inert = siblings.map((element) => [element, element.inert] as const);
    inert.forEach(([element]) => {
      element.inert = true;
    });
    if (container.current) baseline.current = inputState(container.current);
    container.current?.focus({ preventScroll: true });
    return () => {
      inert.forEach(([element, value]) => {
        element.inert = value;
      });
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  function trackInput() {
    if (container.current) dirty.current = inputState(container.current) !== baseline.current;
  }
  return (
    <div
      className="modal-backdrop"
      ref={backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
        tabIndex={-1}
        onInputCapture={trackInput}
        onChangeCapture={trackInput}
        onKeyDown={(event) => {
          if (event.key !== 'Tab' || !isTop()) return;
          const controls = Array.from(
            container.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
            ) ?? [],
          ).filter((element) => element.offsetParent !== null);
          const first = controls[0],
            last = controls.at(-1);
          if (!first || !last) {
            event.preventDefault();
            return;
          }
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === container.current)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            title="关闭"
            aria-label="关闭"
            onClick={close}
          >
            <X size={21} />
          </button>
        </header>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {children}
      </section>
    </div>
  );
}
