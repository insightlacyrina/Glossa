import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, FileInput, History, X } from 'lucide-react';
import { NotebookEngine } from './domain';
import { downloadText, nativeRequest } from './native';
import type { useWorkspace } from './useWorkspace';

type Props = {
  workspace: ReturnType<typeof useWorkspace>;
  onClose: () => void;
  onRestored: () => void;
};
type Entry = ReturnType<typeof useWorkspace>['recoverySnapshots'][number];
type PendingExport = {
  sessionId: string;
  name: string;
  mime: string;
  bytes: number;
  complete: boolean;
};
function projectPackage(entry: Entry) {
  return new NotebookEngine(entry.recovery.workspace.project).exportProject();
}
function summary(entry: Entry) {
  try {
    const engine = new NotebookEngine(entry.recovery.workspace.project);
    return {
      valid: true,
      titles:
        engine.state.notes
          .slice(0, 3)
          .map((n) => n.title)
          .join(' / ') || '空白工程',
      count: engine.state.notes.length,
    };
  } catch {
    return { valid: false, titles: '原始资料待修复', count: 0 };
  }
}
export function RecoveryManager({ workspace: w, onClose, onRestored }: Props) {
  const [items, setItems] = useState(w.recoverySnapshots),
    [selected, setSelected] = useState<Entry>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [exports, setExports] = useState<PendingExport[]>([]);
  const container = useRef<HTMLElement>(null);
  async function refreshExports() {
    if (window.QuietPaperNative?.getPendingExports) {
      const result = (await nativeRequest('getPendingExports')) as Awaited<
        ReturnType<typeof nativeRequest>
      > & { sessions?: PendingExport[] };
      setExports(result.sessions ?? []);
    }
  }
  useEffect(() => {
    void refreshExports().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    void w
      .listRecoverySnapshots()
      .then(setItems)
      .catch((e) => setError(String(e)));
    container.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
      if (event.key === 'Tab') {
        const buttons = Array.from(
          container.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        if (!buttons.length) return;
        if (event.shiftKey && document.activeElement === buttons[0]) {
          event.preventDefault();
          buttons.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
          event.preventDefault();
          buttons[0].focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal wide"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label="本地恢复副本"
      >
        <header>
          <h2>本地恢复副本</h2>
          <button
            className="icon-button"
            disabled={busy}
            aria-label="关闭恢复副本"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </header>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {selected ? (
          <div className="dialog-stack">
            <p>当前工程会先保留恢复副本，再打开所选版本。</p>
            <div className="revision-preview">{summary(selected).titles}</div>
            <div className="button-row">
              <button className="button" disabled={busy} onClick={() => setSelected(undefined)}>
                返回
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await w.importProject(projectPackage(selected));
                    onRestored();
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                确认恢复此版本
                <FileInput size={16} />
              </button>
            </div>
          </div>
        ) : (
          <div className="dialog-stack">
            {!items.length && !exports.length && (
              <div className="empty compact">
                <History size={28} />
                <h3>没有本地恢复副本</h3>
              </div>
            )}
            {exports.map((item) => (
              <article className="revision-card" key={item.sessionId}>
                <div className="eyebrow">
                  {item.complete ? '待完成导出' : '导出暂存未完成'} ·{' '}
                  {(item.bytes / 1024 / 1024).toFixed(1)} MiB
                </div>
                <p>{item.name}</p>
                <div className="button-row">
                  {item.complete && (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await nativeRequest('completeExport', [item.sessionId]);
                          await refreshExports();
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      继续导出
                      <ArrowDownToLine size={16} />
                    </button>
                  )}
                  <button
                    className="button"
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm('清理这份导出暂存？原笔记仍保留在本机。')) return;
                      setBusy(true);
                      try {
                        await nativeRequest('discardExport', [item.sessionId]);
                        await refreshExports();
                      } catch (e) {
                        setError(String(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    清理导出暂存
                  </button>
                </div>
              </article>
            ))}
            {items.map((item) => {
              const info = summary(item);
              return (
                <article className="revision-card" key={item.key}>
                  <div className="eyebrow">
                    {new Date(item.recovery.at).toLocaleString('zh-CN')}
                  </div>
                  <p>{info.titles}</p>
                  <div className="button-row">
                    <button
                      className="button"
                      onClick={() => {
                        try {
                          downloadText('笺注-恢复副本.glossa', projectPackage(item));
                        } catch {
                          downloadText(
                            '笺注-原始恢复资料.json',
                            JSON.stringify(item.recovery, null, 2),
                          );
                        }
                      }}
                    >
                      导出工程副本
                      <ArrowDownToLine size={16} />
                    </button>
                    {info.valid && (
                      <button className="button primary" onClick={() => setSelected(item)}>
                        恢复
                        <FileInput size={16} />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
