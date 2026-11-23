import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Ellipsis, History, Pencil, X } from 'lucide-react';
import { NotebookEngine, type Note, type Segment } from './domain';
import { PaperPreview, visibleObjects } from './Paper';
import { codepointOffset, inputRange, replacedValue, type EditRange } from './structure-edit';
import { useBackHandler } from './ui-navigation';
import { characterLocation, SearchMark, type TextLocation } from './SearchMark';
import type { SearchHit } from './search';
import './structure.css';

export type StructureProps = {
  engine: NotebookEngine;
  note: Note;
  editable: boolean;
  onChange: (action: (e: NotebookEngine) => void) => void;
  onJump: (objectIds: string[], fullPage?: boolean) => void;
  inlineSources?: boolean;
  onOpenPaper?: () => void;
  onProof: (objectIds: string[], segmentId?: string) => void;
  activeBlockId?: string;
  searchHit?: SearchHit | null;
  onReview?: (blockId: string) => void;
};

type EditorProps = {
  engine: NotebookEngine;
  noteId: string;
  segment: Segment;
  onChange: StructureProps['onChange'];
  onDone: () => void;
};
function SegmentEditor({ engine, noteId, segment, onChange, onDone }: EditorProps) {
  const recoveryKey = `editor-draft:${noteId}:${segment.id}`;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const branch = useRef<NotebookEngine | null>(null);
  const dirty = useRef(false),
    blocked = useRef(false),
    finished = useRef(false);
  const pending = useRef<{ before: string; range: EditRange | null } | null>(null);
  const composition = useRef<{ before: string; start: number; end: number } | null>(null);
  const undoStack = useRef<{ forward: EditRange; inverse: EditRange }[]>([]);
  const redoStack = useRef<{ forward: EditRange; inverse: EditRange }[]>([]);
  const [value, setValue] = useState(segment.text);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(() => {
    const saved = engine.state.settings[recoveryKey] as { text?: unknown } | undefined;
    if (saved && typeof saved.text === 'string') return saved.text;
    try {
      return localStorage.getItem(`quiet-paper-${recoveryKey}`);
    } catch {
      return null;
    }
  });
  const changeCallback = useRef(onChange);
  changeCallback.current = onChange;
  const doneCallback = useRef(onDone);
  doneCallback.current = onDone;

  useBackHandler(
    true,
    () => {
      if (composition.current || blocked.current) return true;
      discard();
      return true;
    },
    70,
  );

  function begin() {
    if (!branch.current)
      branch.current = new NotebookEngine(
        structuredClone(engine.project),
        `${engine.deviceId}:editor:${crypto.randomUUID()}`,
        engine.role,
      );
    return branch.current;
  }
  function branchText() {
    return (
      branch.current
        ?.getNote(noteId)
        .blocks.flatMap((b) => b.segments)
        .find((s) => s.id === segment.id)?.text ?? segment.text
    );
  }
  function apply(range: EditRange, expected?: string, recordHistory = true) {
    if (blocked.current) return;
    const working = begin();
    const before = branchText();
    if (expected !== undefined && replacedValue(before, range) !== expected) {
      blocked.current = true;
      setError('输入范围无法验证，草稿已保留。请复制文字后重新选择范围。');
      return;
    }
    try {
      const eventId = working.editRange(
        noteId,
        segment.id,
        range.start,
        range.end,
        range.replacement,
      );
      if (eventId) {
        dirty.current = true;
        if (recordHistory) {
          undoStack.current.push({
            forward: { ...range },
            inverse: {
              start: range.start,
              end: range.start + Array.from(range.replacement).length,
              replacement: Array.from(before).slice(range.start, range.end).join(''),
            },
          });
          redoStack.current = [];
        }
      }
      const next = branchText();
      setValue(next);
      if (textarea.current) textarea.current.value = next;
      setError('');
    } catch (err) {
      blocked.current = true;
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  function commit(close = true) {
    if (finished.current || composition.current || blocked.current) return;
    if (dirty.current && branch.current) {
      let merged = false;
      const project = structuredClone(branch.current.project);
      changeCallback.current((latest) => {
        latest.merge(project);
        merged = true;
      });
      if (!merged) {
        setError('修订尚未保存，草稿仍保留在编辑器中。');
        return;
      }
      dirty.current = false;
    }
    if (close) {
      finished.current = true;
      doneCallback.current();
    }
  }

  useEffect(() => {
    const el = textarea.current!;
    begin();
    el.focus();
    const nativeBeforeInput = (event: Event) => {
      const input = event as InputEvent;
      const before = el.value;
      const range = inputRange(
        before,
        el.selectionStart,
        el.selectionEnd,
        input.inputType,
        input.data,
      );
      if (composition.current || input.isComposing || /Composition/.test(input.inputType)) return;
      pending.current = { before, range };
      if (!range || !input.cancelable || blocked.current) return;
      input.preventDefault();
      pending.current = null;
      apply(range);
      const caret =
        Array.from(before).slice(0, range.start).join('').length + range.replacement.length;
      el.setSelectionRange(caret, caret);
    };
    const nativeInput = () => {
      if (composition.current) {
        setValue(el.value);
        return;
      }
      const known = pending.current;
      pending.current = null;
      if (el.value === branchText()) {
        setValue(el.value);
        return;
      }
      if (known?.range && replacedValue(known.before, known.range) === el.value)
        apply(known.range, el.value);
      else {
        blocked.current = true;
        setValue(el.value);
        setError('输入范围无法验证，草稿已保留。请复制文字后重新选择范围。');
      }
    };
    const nativePaste = (event: ClipboardEvent) => {
      if (blocked.current || composition.current || !event.clipboardData) return;
      event.preventDefault();
      const range = {
        start: codepointOffset(el.value, el.selectionStart),
        end: codepointOffset(el.value, el.selectionEnd),
        replacement: event.clipboardData.getData('text/plain'),
      };
      const before = el.value;
      apply(range);
      const caret =
        Array.from(before).slice(0, range.start).join('').length + range.replacement.length;
      el.setSelectionRange(caret, caret);
    };
    const nativeCompositionStart = () => {
      composition.current = {
        before: el.value,
        start: codepointOffset(el.value, el.selectionStart),
        end: codepointOffset(el.value, el.selectionEnd),
      };
    };
    const nativeCompositionEnd = (event: CompositionEvent) => {
      const started = composition.current;
      composition.current = null;
      pending.current = null;
      if (!started) return;
      const range = { start: started.start, end: started.end, replacement: event.data };
      if (replacedValue(started.before, range) !== el.value) {
        blocked.current = true;
        setValue(el.value);
        setError('输入法未提供可验证的替换范围，草稿已保留。');
        return;
      }
      apply(range, el.value);
    };
    el.addEventListener('beforeinput', nativeBeforeInput);
    el.addEventListener('input', nativeInput);
    el.addEventListener('paste', nativePaste);
    el.addEventListener('compositionstart', nativeCompositionStart);
    el.addEventListener('compositionend', nativeCompositionEnd);
    return () => {
      el.removeEventListener('beforeinput', nativeBeforeInput);
      el.removeEventListener('input', nativeInput);
      el.removeEventListener('paste', nativePaste);
      el.removeEventListener('compositionstart', nativeCompositionStart);
      el.removeEventListener('compositionend', nativeCompositionEnd);
      if (!finished.current && dirty.current && !blocked.current && branch.current) {
        const project = structuredClone(branch.current.project);
        changeCallback.current((latest) => latest.merge(project));
        dirty.current = false;
      }
      // Unsupported input never becomes a guessed operation. Its text is an explicit recovery record.
      if (blocked.current) {
        let retained = false;
        changeCallback.current((latest) => {
          latest.setSetting(recoveryKey, {
            text: el.value,
            noteId,
            segmentId: segment.id,
            at: Date.now(),
            reason: 'unverified-editor-range',
          });
          retained = true;
        });
        if (!retained) {
          try {
            localStorage.setItem(`quiet-paper-${recoveryKey}`, el.value);
          } catch {
            /* Current editor retains the draft until the user leaves. */
          }
        }
      }
    };
  }, []);

  function discard() {
    if ((dirty.current || blocked.current) && !window.confirm('放弃这次尚未保存的修订？')) return;
    finished.current = true;
    dirty.current = false;
    blocked.current = false;
    onDone();
  }
  function undo(redo = false) {
    if (blocked.current || composition.current) return;
    const source = redo ? redoStack.current : undoStack.current;
    const target = redo ? undoStack.current : redoStack.current;
    const operation = source.pop();
    if (!operation) return;
    const range = redo ? operation.forward : operation.inverse;
    apply(range, undefined, false);
    target.push(operation);
    const text = branchText();
    const caret = Array.from(text)
      .slice(0, range.start + Array.from(range.replacement).length)
      .join('').length;
    textarea.current?.setSelectionRange(caret, caret);
  }
  return (
    <div
      className="structure-editor"
      ref={wrapper}
      onBlur={(event) => {
        if (!wrapper.current?.contains(event.relatedTarget as Node | null)) commit();
      }}
    >
      {recovery !== null && (
        <details className="structure-recovery">
          <summary>保留的未定位草稿</summary>
          <textarea aria-label="保留的未定位草稿" readOnly value={recovery} rows={4} />
          <div className="structure-editor-actions">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(recovery)
                  .catch(() => setError('请选中保留的文字并复制。'));
              }}
            >
              复制草稿
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm('清除这份未定位草稿？已保存的笔记内容不受影响。')) return;
                onChange((latest) => latest.setSetting(recoveryKey, null));
                try {
                  localStorage.removeItem(`quiet-paper-${recoveryKey}`);
                } catch {
                  /* The project recovery record is already cleared. */
                }
                setRecovery(null);
              }}
            >
              清除草稿
            </button>
          </div>
        </details>
      )}
      <textarea
        ref={textarea}
        defaultValue={segment.text}
        className={
          segment.kind === 'formula' ? 'structure-input structure-input-formula' : 'structure-input'
        }
        aria-label={segment.kind === 'formula' ? '编辑已有公式' : '编辑已有文字'}
        rows={Math.max(3, Math.min(14, value.split('\n').length + 1))}
        spellCheck={false}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            undo(event.shiftKey);
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            undo(true);
          }
        }}
      />
      {error && (
        <p className="structure-editor-error" role="alert">
          {error}
        </p>
      )}
      <div className="structure-editor-actions">
        {blocked.current && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(textarea.current?.value ?? value)
                .catch(() => setError('请选中文字并复制。'));
            }}
          >
            复制草稿
          </button>
        )}
        <button type="button" className="structure-quiet-button" onClick={discard}>
          <X size={15} />
          取消
        </button>
        <button
          type="button"
          className="structure-save"
          onClick={() => commit()}
          disabled={blocked.current}
        >
          <Check size={15} />
          保存修订
        </button>
      </div>
    </div>
  );
}

function ReferenceView({
  engine,
  note,
  segment,
  location,
  hideOriginal,
}: {
  engine: NotebookEngine;
  note: Note;
  segment: Segment;
  location?: TextLocation;
  hideOriginal: boolean;
}) {
  const correspondence = engine.findCorrespondence(note.id, segment.id);
  const objectIds =
    correspondence.status === 'exact' ? correspondence.objectIds : segment.source.objectIds;
  const pages = note.pages.filter((page) =>
    visibleObjects(page).some((object) => objectIds.includes(object.id)),
  );
  if (hideOriginal) {
    return (
      <div className="structure-reference-caption">
        {segment.text ? <SearchMark text={segment.text} location={location} /> : '原稿引用'}
      </div>
    );
  }
  return (
    <div className="structure-reference">
      {pages.map((page) => (
        <figure key={page.id}>
          <PaperPreview page={page} objectIds={objectIds} />
          {pages.length > 1 && <figcaption>第 {note.pages.indexOf(page) + 1} 页</figcaption>}
        </figure>
      ))}
      {!pages.length && segment.preview && <img src={segment.preview} alt="原始对象快照" />}
      {!pages.length && !segment.preview && <p className="structure-missing">来源对象待恢复</p>}
      {segment.text && (
        <div className="structure-reference-caption">
          <SearchMark text={segment.text} location={location} />
        </div>
      )}
    </div>
  );
}

export function Structure(props: StructureProps) {
  const {
    engine,
    note,
    editable,
    onChange,
    onJump,
    onProof,
    activeBlockId,
    onReview,
    searchHit,
    inlineSources,
  } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [blockTools, setBlockTools] = useState<string | null>(null);
  const sourceAnchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = sourceAnchor.current;
    sourceAnchor.current = null;
    if (anchor?.element.isConnected) {
      const shift = anchor.element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(shift) > 1) window.scrollBy(0, shift);
    }
  }, [expandedSource]);
  function showSource(segmentId: string, expanded: boolean) {
    const next = expanded ? segmentId : null;
    if (next === expandedSource) return;
    const element = document.getElementById(`segment-${segmentId}`);
    if (element) sourceAnchor.current = { element, top: element.getBoundingClientRect().top };
    setExpandedSource(next);
  }
  useBackHandler(
    !!menu || !!history || (!!expandedSource && !!inlineSources) || !!blockTools,
    () => {
      if (menu) setMenu(null);
      else if (history) setHistory(null);
      else if (blockTools) setBlockTools(null);
      else setExpandedSource(null);
      return true;
    },
    60,
  );
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const valid = new Map(
    engine.validateMappings().map((result) => [result.segmentId, result.valid]),
  );
  useEffect(() => {
    setEditing(null);
    setMenu(null);
    setHistory(null);
    setSelectedSegment(null);
    setExpandedSource(null);
    setBlockTools(null);
  }, [note.id]);
  useEffect(() => {
    if (!activeBlockId) return;
    const frame = requestAnimationFrame(() => {
      const block = document.getElementById(`structure-block-${activeBlockId}`);
      const target = searchHit
        ? (block?.querySelector('.search-location-mark') ??
          (searchHit.segmentId && document.getElementById(`segment-${searchHit.segmentId}`)) ??
          block)
        : block;
      if (target)
        target.scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: searchHit ? 'center' : 'nearest',
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeBlockId, searchHit]);
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current.timer);
    },
    [],
  );
  const clearPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const blocks = note.blocks;
  return (
    <div className="structure-view" aria-label="整理内容">
      {!blocks.length && (
        <div className="structure-empty">
          <p>还没有整理稿</p>
          <button className="button" onClick={props.onOpenPaper}>
            查看原稿 <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      {blocks.map((block) => (
        <section
          className={`structure-block ${activeBlockId === block.id ? 'structure-block-active' : ''}`}
          id={`structure-block-${block.id}`}
          key={block.id}
        >
          <header className="structure-block-heading">
            <h2>
              <SearchMark
                text={block.title}
                location={
                  searchHit?.kind === 'concept' && searchHit.blockId === block.id
                    ? searchHit.location
                    : undefined
                }
              />
            </h2>
            <div className="structure-block-actions">
              <button
                type="button"
                className="structure-icon-button"
                aria-label="知识块操作"
                aria-expanded={blockTools === block.id}
                onClick={() => setBlockTools(blockTools === block.id ? null : block.id)}
              >
                <Ellipsis size={17} />
              </button>
              {blockTools === block.id && (
                <div className="structure-context-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setBlockTools(null);
                      setHistory(history === block.id ? null : block.id);
                    }}
                  >
                    知识块历史 <History size={15} />
                  </button>
                  {onReview && (
                    <button
                      type="button"
                      onClick={() => {
                        setBlockTools(null);
                        onReview(block.id);
                      }}
                    >
                      复习 <ArrowUpRight size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </header>
          {block.segments
            .filter((segment) => !segment.deleted)
            .map((segment) => {
              const correspondence = engine.findCorrespondence(note.id, segment.id);
              const exact = correspondence.status === 'exact' && valid.get(segment.id) === true;
              const showingSource = exact && inlineSources && expandedSource === segment.id;
              const sourcePages = showingSource
                ? note.pages.filter((page) =>
                    visibleObjects(page).some((object) =>
                      correspondence.objectIds.includes(object.id),
                    ),
                  )
                : [];
              function openSource() {
                if (!exact) {
                  onProof(segment.source.objectIds, segment.id);
                } else if (inlineSources) {
                  setSelectedSegment(segment.id);
                  showSource(segment.id, !showingSource);
                } else onJump(correspondence.objectIds);
              }
              const located = searchHit?.segmentId === segment.id;
              const location = located ? characterLocation(segment, searchHit?.charIds) : undefined;
              return (
                <article
                  id={`segment-${segment.id}`}
                  key={segment.id}
                  className={`structure-segment structure-segment-${segment.kind}${located ? ' search-location-segment' : ''}${selectedSegment === segment.id || menu === segment.id ? ' structure-segment-selected' : ''}`}
                  onContextMenu={(event) => {
                    if (editing !== segment.id) {
                      event.preventDefault();
                      setMenu(segment.id);
                    }
                  }}
                >
                  {editing === segment.id ? (
                    <SegmentEditor
                      key={segment.id}
                      engine={engine}
                      noteId={note.id}
                      segment={segment}
                      onChange={onChange}
                      onDone={() => setEditing(null)}
                    />
                  ) : (
                    <div
                      className="structure-segment-content"
                      onClick={() => {
                        if (menu === segment.id || window.getSelection()?.toString()) return;
                        setSelectedSegment(segment.id);
                        if (exact && inlineSources) showSource(segment.id, true);
                      }}
                      onDoubleClick={() => {
                        if (editable && segment.kind !== 'reference') setEditing(segment.id);
                      }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        clearPress();
                        press.current = {
                          x: event.clientX,
                          y: event.clientY,
                          timer: setTimeout(() => {
                            setMenu(segment.id);
                            press.current = null;
                          }, 550),
                        };
                      }}
                      onPointerMove={(event) => {
                        if (
                          press.current &&
                          Math.hypot(
                            event.clientX - press.current.x,
                            event.clientY - press.current.y,
                          ) > 8
                        )
                          clearPress();
                      }}
                      onPointerUp={clearPress}
                      onPointerCancel={clearPress}
                    >
                      {segment.kind === 'reference' ? (
                        <ReferenceView
                          engine={engine}
                          note={note}
                          segment={segment}
                          location={location}
                          hideOriginal={Boolean(exact && inlineSources)}
                        />
                      ) : (
                        <div
                          className={
                            segment.kind === 'formula' ? 'structure-formula' : 'structure-prose'
                          }
                        >
                          {segment.text ? (
                            <SearchMark text={segment.text} location={location} />
                          ) : (
                            <span className="structure-empty-text">空白段落</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="structure-segment-meta">
                    <button
                      type="button"
                      className={`structure-mapping ${exact ? 'structure-mapping-exact' : 'structure-mapping-pending'}`}
                      aria-expanded={exact && inlineSources ? showingSource : undefined}
                      aria-controls={showingSource ? `source-${segment.id}` : undefined}
                      onClick={openSource}
                    >
                      {!exact ? '待校对' : showingSource ? '收起原稿' : '看原稿'}
                      {exact &&
                        (inlineSources ? <ChevronDown size={13} /> : <ArrowUpRight size={13} />)}
                    </button>
                    <div className="structure-segment-tools">
                      {editable && segment.kind !== 'reference' && editing !== segment.id && (
                        <button
                          type="button"
                          className="structure-icon-button"
                          aria-label={segment.kind === 'formula' ? '修订公式' : '修订文字'}
                          onClick={() => {
                            setEditing(segment.id);
                            setMenu(null);
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="structure-icon-button"
                        aria-label="段落菜单"
                        aria-expanded={menu === segment.id}
                        onClick={() => setMenu(menu === segment.id ? null : segment.id)}
                      >
                        <Ellipsis size={17} />
                      </button>
                    </div>
                  </div>
                  {showingSource && sourcePages.length > 0 && (
                    <div className="structure-inline-source" id={`source-${segment.id}`}>
                      {sourcePages.map((page) => (
                        <figure key={page.id}>
                          <figcaption>
                            <span>原稿 · 第 {note.pages.indexOf(page) + 1} 页</span>
                            <button
                              type="button"
                              onClick={() =>
                                onJump(
                                  visibleObjects(page)
                                    .filter((object) =>
                                      correspondence.objectIds.includes(object.id),
                                    )
                                    .map((object) => object.id),
                                  true,
                                )
                              }
                            >
                              查看整页 <ArrowUpRight size={13} />
                            </button>
                          </figcaption>
                          <div className="structure-source-crop">
                            <PaperPreview
                              page={page}
                              objectIds={correspondence.objectIds}
                              minimumScale={segment.kind === 'reference' ? undefined : 0.8}
                            />
                          </div>
                        </figure>
                      ))}
                    </div>
                  )}
                  {menu === segment.id && (
                    <div className="structure-context-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          if (exact) onJump(correspondence.objectIds, true);
                          else onProof(segment.source.objectIds, segment.id);
                        }}
                      >
                        转到原稿 <ArrowUpRight size={14} />
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          onProof(segment.source.objectIds, segment.id);
                        }}
                      >
                        校对来源
                      </button>
                      {editable && segment.kind !== 'reference' && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(null);
                            setEditing(segment.id);
                          }}
                        >
                          修订内容
                        </button>
                      )}
                      <button type="button" role="menuitem" onClick={() => setMenu(null)}>
                        收起 <ChevronDown size={14} />
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          {!block.segments.some((segment) => !segment.deleted) && (
            <p className="structure-block-waiting">内容待整理</p>
          )}
          {block.relatedBlockIds.length > 0 && (
            <div className="structure-relations">
              {block.relatedBlockIds.map((id) => {
                const related = engine.state.notes
                  .flatMap((n) => n.blocks.map((b) => ({ note: n, block: b })))
                  .find((item) => item.block.id === id);
                return (
                  <span key={id}>
                    {related?.block.title ?? '关联知识块'} <ArrowUpRight size={12} />
                  </span>
                );
              })}
            </div>
          )}
          {history === block.id && (
            <div className="structure-history" aria-label="知识块版本历史">
              <div className="structure-history-heading">
                <span>版本历史</span>
                <button
                  className="structure-icon-button"
                  type="button"
                  aria-label="关闭版本历史"
                  onClick={() => setHistory(null)}
                >
                  <X size={15} />
                </button>
              </div>
              {block.versions.length ? (
                [...block.versions].reverse().map((version) => (
                  <div
                    className="structure-history-version"
                    key={`${version.eventId}:${version.segmentId}`}
                  >
                    <time dateTime={new Date(version.at).toISOString()}>
                      {new Date(version.at).toLocaleString('zh-CN')}
                    </time>
                    <p>{version.text || '∅'}</p>
                  </div>
                ))
              ) : (
                <p>尚无修订</p>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export default Structure;
