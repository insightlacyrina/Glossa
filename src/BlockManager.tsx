import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Combine, GitBranch, RefreshCw, Scissors, X } from 'lucide-react';
import { NotebookEngine, type KnowledgeBlock, type Note, type Page, type Segment } from './domain';
import { PaperPreview } from './Paper';
import { useBackHandler } from './ui-navigation';
import './block-manager.css';

export type BlockManagerProps = {
  engine: NotebookEngine;
  note: Note;
  onChange: (fn: (engine: NotebookEngine) => void) => boolean;
  onClose: () => void;
};
type Mode = 'split' | 'merge' | 'link';
type BlockSnapshot = {
  noteId: string;
  noteTitle: string;
  block: KnowledgeBlock;
  pages: Page[];
  objectVersions: { id: string; version: string }[];
};
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  );
}

function capture(engine: NotebookEngine): BlockSnapshot[] {
  return engine.state.notes.flatMap((note) => {
    // Paper snapshots are shared by blocks in the same note, rather than copying every stroke per block.
    const pages = structuredClone(note.pages);
    return note.blocks.map((block) => {
      const ids = new Set([
        ...block.objectIds,
        ...block.segments.flatMap((segment) => segment.source.objectIds),
        ...block.segments.flatMap(
          (segment) => engine.findCorrespondence(note.id, segment.id).objectIds,
        ),
      ]);
      return {
        noteId: note.id,
        noteTitle: note.title,
        block: structuredClone(block),
        pages,
        objectVersions: note.pages
          .flatMap((page) => page.objects)
          .filter((object) => !object.deleted && ids.has(object.id))
          .map((object) => ({ id: object.id, version: object.version })),
      };
    });
  });
}
function verify(engine: NotebookEngine, expected: BlockSnapshot[]) {
  if (engine.role !== 'tablet') throw new Error('知识块结构操作仅限 Android 平板');
  for (const snapshot of expected) {
    const note = engine.state.notes.find((note) => note.id === snapshot.noteId);
    const current = note?.blocks.find((block) => block.id === snapshot.block.id);
    if (!note || !current || canonical(current) !== canonical(snapshot.block))
      throw new Error('知识块已改变。选择与名称已保留，请更新预览后确认。');
    const objects = note.pages.flatMap((page) => page.objects);
    if (
      snapshot.objectVersions.some(
        (old) =>
          !objects.some(
            (object) => object.id === old.id && !object.deleted && object.version === old.version,
          ),
      )
    )
      throw new Error('原稿已改变。选择与名称已保留，请更新预览后确认。');
  }
}
const activeSegments = (snapshot?: BlockSnapshot) =>
  snapshot?.block.segments.filter((segment) => !segment.deleted) ?? [];
const kindName = (segment: Segment) =>
  segment.kind === 'formula' ? '公式' : segment.kind === 'reference' ? '对象' : '文字';

function SegmentPreview({ segment, index }: { segment: Segment; index: number }) {
  return (
    <div className="bm-segment-preview" data-segment-id={segment.id}>
      <span>
        {String(index + 1).padStart(2, '0')} · {kindName(segment)}
      </span>
      <p className={segment.kind === 'formula' ? 'bm-formula' : ''}>{segment.text || '空段落'}</p>
    </div>
  );
}
function GroupPreview({
  title,
  snapshot,
  segments,
}: {
  title: string;
  snapshot?: BlockSnapshot;
  segments: Segment[];
}) {
  const ids = new Set(segments.flatMap((segment) => segment.source.objectIds));
  const originalIds = new Set(ids);
  for (const page of snapshot?.pages ?? [])
    for (const object of page.objects)
      if (!object.deleted && object.replacesObjectIds?.some((id) => originalIds.has(id)))
        ids.add(object.id);
  const pages =
    snapshot?.pages.filter((page) =>
      page.objects.some((object) => !object.deleted && ids.has(object.id)),
    ) ?? [];
  return (
    <section className="bm-result-card">
      <h4>{title}</h4>
      <div className="bm-result-segments">
        {segments.length ? (
          segments.map((segment, index) => (
            <SegmentPreview key={segment.id} segment={segment} index={index} />
          ))
        ) : (
          <div className="bm-empty-selection">尚未选择段落</div>
        )}
      </div>
      {pages.length > 0 && (
        <div className="bm-object-previews">
          {pages.map((page) => (
            <div key={page.id}>
              <span>
                纸张 {(snapshot?.pages.findIndex((item) => item.id === page.id) ?? 0) + 1}
              </span>
              <PaperPreview page={page} objectIds={[...ids]} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function BlockManager(props: BlockManagerProps) {
  return props.engine.role === 'tablet' ? <TabletBlockManager {...props} /> : null;
}
function TabletBlockManager({ engine, note, onChange, onClose }: BlockManagerProps) {
  const [snapshots, setSnapshots] = useState(() => capture(engine));
  const [mode, setMode] = useState<Mode>('split');
  const [sourceId, setSourceId] = useState(() => note.blocks[0]?.id ?? '');
  const [splitIds, setSplitIds] = useState<string[]>([]);
  const [splitTitle, setSplitTitle] = useState('新的知识块');
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [mergeTitle, setMergeTitle] = useState('合并后的知识块');
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const committedTitles = useRef({ split: '新的知识块', merge: '合并后的知识块' });
  const hasPendingChanges = !!(
    splitIds.length ||
    mergeIds.length ||
    targetId ||
    splitTitle !== committedTitles.current.split ||
    mergeTitle !== committedTitles.current.merge
  );
  function safeClose() {
    if (hasPendingChanges && !window.confirm('放弃尚未应用的知识块名称和选择？')) return;
    onClose();
  }
  const isTopLayer = useBackHandler(
    true,
    () => {
      safeClose();
      return true;
    },
    80,
  );
  const localBlocks = snapshots.filter((snapshot) => snapshot.noteId === note.id);
  const source = localBlocks.find((snapshot) => snapshot.block.id === sourceId);
  const sourceSegments = activeSegments(source);
  const selectedSegments = sourceSegments.filter((segment) => splitIds.includes(segment.id));
  const retainedSegments = sourceSegments.filter((segment) => !splitIds.includes(segment.id));
  // Merge order follows note order, independently of where blocks appear on paper.
  const mergeBlocks = localBlocks.filter((snapshot) => mergeIds.includes(snapshot.block.id));
  const mergedSegments = mergeBlocks.flatMap((snapshot) => activeSegments(snapshot));
  const target = snapshots.find(
    (snapshot) => snapshot.block.id === targetId && snapshot.block.id !== sourceId,
  );
  const targets = snapshots.filter((snapshot) => snapshot.block.id !== sourceId);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = dialog.current?.querySelector<HTMLElement>('button');
    initial?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopLayer()) return;
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ) ?? []),
      ].filter((element) => element.offsetParent !== null);
      const first = controls[0],
        last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function refresh() {
    const next = capture(engine),
      ids = new Set(
        next.flatMap((snapshot) => snapshot.block.segments.map((segment) => segment.id)),
      );
    setSnapshots(next);
    setSplitIds((current) => current.filter((id) => ids.has(id)));
    setMergeIds((current) =>
      current.filter((id) => next.some((snapshot) => snapshot.block.id === id)),
    );
    setError('');
    setNotice('预览已更新');
    if (!next.some((snapshot) => snapshot.block.id === sourceId && snapshot.noteId === note.id))
      setSourceId(next.find((snapshot) => snapshot.noteId === note.id)?.block.id ?? '');
    if (!next.some((snapshot) => snapshot.block.id === targetId)) setTargetId('');
  }
  function chooseSource(id: string) {
    setSourceId(id);
    setSplitIds([]);
    setError('');
    setNotice('');
    if (id === targetId) setTargetId('');
  }
  function toggle(ids: string[], id: string) {
    return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
  }
  function commit(
    expected: BlockSnapshot[],
    change: (engine: NotebookEngine) => string | void,
    success: string,
  ) {
    let failure = '',
      nextSource: string | void = undefined;
    try {
      const accepted = onChange((current) => {
        try {
          verify(current, expected);
          nextSource = change(current);
        } catch (cause) {
          failure = cause instanceof Error ? cause.message : String(cause);
          throw cause;
        }
      });
      if (!accepted) {
        setError(failure || '保存未完成，当前选择已保留');
        return;
      }
      if (mode === 'split') committedTitles.current.split = splitTitle;
      if (mode === 'merge') committedTitles.current.merge = mergeTitle;
      setSnapshots(capture(engine));
      setSplitIds([]);
      setMergeIds([]);
      setTargetId('');
      if (typeof nextSource === 'string') setSourceId(nextSource);
      setError('');
      setNotice(success);
    } catch (cause) {
      setError(failure || (cause instanceof Error ? cause.message : String(cause)));
    }
  }
  function submit() {
    if (mode === 'split') {
      if (!source || !selectedSegments.length || !retainedSegments.length || !splitTitle.trim()) {
        setError('请选择原块中的部分段落，并填写新块名称');
        return;
      }
      commit(
        [source],
        (current) =>
          current.splitBlock(
            note.id,
            source.block.id,
            selectedSegments.map((segment) => segment.id),
            splitTitle.trim(),
          ),
        '知识块已拆分',
      );
    } else if (mode === 'merge') {
      if (mergeBlocks.length < 2 || !mergeTitle.trim()) {
        setError('请选择至少两个知识块，并填写名称');
        return;
      }
      commit(
        mergeBlocks,
        (current) =>
          current.mergeBlocks(
            note.id,
            mergeBlocks.map((snapshot) => snapshot.block.id),
            mergeTitle.trim(),
          ),
        '知识块已合并',
      );
    } else {
      if (!source || !target) {
        setError('请选择关联的知识块');
        return;
      }
      if (source.block.relatedBlockIds.includes(target.block.id)) {
        setError('这两个知识块已有此关联');
        return;
      }
      commit(
        [source, target],
        (current) => current.linkBlocks(note.id, source.block.id, target.block.id),
        '知识关联已建立',
      );
    }
  }

  if (engine.role !== 'tablet') return null;
  return (
    <div
      className="bm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) safeClose();
      }}
    >
      <section
        ref={dialog}
        className="block-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bm-title"
      >
        <header className="bm-header">
          <div>
            <span className="bm-kicker">KNOWLEDGE</span>
            <h2 id="bm-title">知识块</h2>
          </div>
          <div>
            <button
              className="bm-icon"
              type="button"
              aria-label="更新知识块预览"
              title="更新预览"
              onClick={refresh}
            >
              <RefreshCw size={18} />
            </button>
            <button
              className="bm-icon"
              type="button"
              aria-label="关闭知识块管理"
              onClick={safeClose}
            >
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="bm-tabs" role="tablist" aria-label="知识块操作">
          {(
            [
              { id: 'split', title: '拆分', icon: Scissors },
              { id: 'merge', title: '合并', icon: Combine },
              { id: 'link', title: '关联', icon: GitBranch },
            ] as const
          ).map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={mode === item.id}
              key={item.id}
              onClick={() => {
                setMode(item.id);
                setError('');
                setNotice('');
              }}
            >
              <item.icon size={17} />
              {item.title}
            </button>
          ))}
        </div>
        {error && (
          <div className="bm-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={refresh}>
              更新预览
              <RefreshCw size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div className="bm-notice" role="status">
            <Check size={16} />
            {notice}
          </div>
        )}
        {!localBlocks.length ? (
          <div className="bm-empty">
            <GitBranch size={30} />
            <h3>尚无知识块</h3>
            <button className="bm-button" type="button" onClick={safeClose}>
              回到纸张
              <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <form
            className="bm-layout"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <aside
              className="bm-block-list"
              aria-label={mode === 'merge' ? '选择待合并知识块' : '选择原知识块'}
            >
              {localBlocks.map((snapshot) => {
                const selected =
                  mode === 'merge'
                    ? mergeIds.includes(snapshot.block.id)
                    : sourceId === snapshot.block.id;
                return (
                  <label
                    key={snapshot.block.id}
                    className={`bm-block-option ${selected ? 'selected' : ''}`}
                  >
                    <input
                      type={mode === 'merge' ? 'checkbox' : 'radio'}
                      name="bm-source"
                      aria-label={`${mode === 'merge' ? '合并' : '选择'} ${snapshot.block.title}`}
                      checked={selected}
                      onChange={() =>
                        mode === 'merge'
                          ? setMergeIds(toggle(mergeIds, snapshot.block.id))
                          : chooseSource(snapshot.block.id)
                      }
                    />
                    <span>
                      <strong>{snapshot.block.title}</strong>
                      <span>
                        {activeSegments(snapshot).length} 段 · {snapshot.block.pageIds.length} 页
                      </span>
                    </span>
                  </label>
                );
              })}
            </aside>
            <div className="bm-workspace">
              {mode === 'split' && source && (
                <>
                  <label className="bm-field">
                    新知识块名称
                    <input
                      value={splitTitle}
                      onChange={(event) => setSplitTitle(event.target.value)}
                      required
                      aria-label="拆分后的新块名称"
                    />
                  </label>
                  <fieldset className="bm-segment-selection">
                    <legend>移入新块的段落</legend>
                    {sourceSegments.map((segment, index) => (
                      <label
                        key={segment.id}
                        className={splitIds.includes(segment.id) ? 'selected' : ''}
                      >
                        <input
                          type="checkbox"
                          checked={splitIds.includes(segment.id)}
                          aria-label={`移动段落 ${index + 1}：${Array.from(segment.text).slice(0, 32).join('')}`}
                          onChange={() => setSplitIds(toggle(splitIds, segment.id))}
                        />
                        <SegmentPreview segment={segment} index={index} />
                      </label>
                    ))}
                  </fieldset>
                  <div className="bm-comparison">
                    <GroupPreview
                      title={`保留 · ${source.block.title}`}
                      snapshot={source}
                      segments={retainedSegments}
                    />
                    <GroupPreview
                      title={splitTitle.trim() || '新知识块'}
                      snapshot={source}
                      segments={selectedSegments}
                    />
                  </div>
                  <button
                    type="submit"
                    className="bm-button primary"
                    disabled={
                      !selectedSegments.length || !retainedSegments.length || !splitTitle.trim()
                    }
                  >
                    确认拆分
                    <Scissors size={17} />
                  </button>
                </>
              )}
              {mode === 'merge' && (
                <>
                  <label className="bm-field">
                    合并后的名称
                    <input
                      value={mergeTitle}
                      onChange={(event) => setMergeTitle(event.target.value)}
                      required
                      aria-label="合并后的知识块名称"
                    />
                  </label>
                  <div className="bm-merge-before">
                    {mergeBlocks.map((snapshot) => (
                      <GroupPreview
                        key={snapshot.block.id}
                        title={snapshot.block.title}
                        snapshot={snapshot}
                        segments={activeSegments(snapshot)}
                      />
                    ))}
                  </div>
                  <div className="bm-preview-heading">
                    <Combine size={19} />
                    <h3>{mergeTitle.trim() || '合并后的知识块'}</h3>
                  </div>
                  <div className="bm-merged-preview">
                    {mergedSegments.length ? (
                      mergedSegments.map((segment, index) => (
                        <SegmentPreview key={segment.id} segment={segment} index={index} />
                      ))
                    ) : (
                      <div className="bm-empty-selection">选择待合并的知识块</div>
                    )}
                  </div>
                  <button
                    type="submit"
                    className="bm-button primary"
                    disabled={mergeBlocks.length < 2 || !mergeTitle.trim()}
                  >
                    确认合并
                    <Combine size={17} />
                  </button>
                </>
              )}
              {mode === 'link' && source && (
                <>
                  <label className="bm-field">
                    关联到
                    <select
                      value={targetId}
                      onChange={(event) => setTargetId(event.target.value)}
                      required
                      aria-label="选择关联目标知识块"
                    >
                      <option value="">选择知识块</option>
                      {[...new Set(targets.map((snapshot) => snapshot.noteId))].map((noteId) => (
                        <optgroup
                          key={noteId}
                          label={targets.find((snapshot) => snapshot.noteId === noteId)!.noteTitle}
                        >
                          {targets
                            .filter((snapshot) => snapshot.noteId === noteId)
                            .map((snapshot) => (
                              <option key={snapshot.block.id} value={snapshot.block.id}>
                                {snapshot.block.title}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <div className="bm-link-preview">
                    <GroupPreview
                      title={source.block.title}
                      snapshot={source}
                      segments={activeSegments(source)}
                    />
                    <ArrowRight className="bm-relation-arrow" size={24} />
                    {target ? (
                      <GroupPreview
                        title={`${target.noteTitle} / ${target.block.title}`}
                        snapshot={target}
                        segments={activeSegments(target)}
                      />
                    ) : (
                      <div className="bm-empty-selection">选择关联目标</div>
                    )}
                  </div>
                  {source.block.relatedBlockIds.length > 0 && (
                    <div className="bm-existing-links">
                      <h3>已有关系</h3>
                      {source.block.relatedBlockIds.map((id) => {
                        const related = snapshots.find((snapshot) => snapshot.block.id === id);
                        return (
                          <div key={id}>
                            <GitBranch size={16} />
                            <span>
                              {related ? `${related.noteTitle} / ${related.block.title}` : id}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <button
                    type="submit"
                    className="bm-button primary"
                    disabled={!target || source.block.relatedBlockIds.includes(target.block.id)}
                  >
                    建立关联
                    <GitBranch size={17} />
                  </button>
                </>
              )}
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
