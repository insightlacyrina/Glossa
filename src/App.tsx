import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudOff,
  Ellipsis,
  Eraser,
  FileInput,
  FileText,
  Folder,
  GitBranch,
  Highlighter,
  History,
  ImagePlus,
  Layers,
  Link2,
  Menu,
  MoreHorizontal,
  PenLine,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { useWorkspace } from './useWorkspace';
import {
  NotebookEngine,
  type Bounds,
  type Conflict,
  type Note,
  type PaperObject,
  type PaperSpec,
  type Point,
  type Segment,
} from './domain';
import { Paper, PaperPreview, visibleObjects, type Tool } from './Paper';
import { Structure } from './Structure';
import { BlockManager } from './BlockManager';
import { RecoveryManager } from './RecoveryManager';
import { DialogShell, inputState } from './DialogShell';
import { dispatchBackHandlers, useBackHandler } from './ui-navigation';
import { readLocal } from './storage';
import {
  PIPELINE_STAGES,
  straightenLine,
  type PipelineStage,
  type RecognitionResult,
} from './automation';
import {
  createReviewCard,
  dueReviews,
  projectReviewEvents,
  scheduleReview,
  type ReviewAssessmentEvent,
  type ReviewCard,
  type ReviewSettings,
} from './review';
import {
  createNativeLink,
  deleteLinkedObject,
  openNative,
  reconcileNativeLink,
  serializeNative,
} from './formats';
import {
  acknowledgeNativeResolution,
  beginNativeResolution,
  bindSourceObject,
  captureSourcePaper,
  captureStillCurrent,
  chooseSourceConflict,
  confirmSourceDeletion,
  identifySourceRead,
  previewNativePending,
  queueCurrentPaper,
  recordSourceFailure,
  refreshPendingSourceRead,
  verifyNativePending,
  type SourceRecord,
  type PaperCapture,
} from './source-coordinator';
import { downloadText, nativeRequest, type NativeReply } from './native';
import { RecognitionSettings } from './RecognitionSettings';
import './style.css';

type View = 'paper' | 'library' | 'review' | 'proof' | 'activity';
type Modal = { title: string; content: ReactNode; wide?: boolean } | null;
const STAGES: Record<PipelineStage, string> = {
  ocr: '文字识别',
  formula: '公式识别',
  classification: '归档分类',
  layout: '几何整理',
  structure: '知识结构',
  review: '复习排期',
};
const STATUS: Record<string, string> = {
  disabled: '已停用',
  idle: '待命',
  waiting: '等待停笔',
  running: '处理中',
  ready: '已完成',
  'needs-review': '待校对',
  unconfigured: '待配置识别服务',
  error: '出错',
};
const date = (n: number) =>
  new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(n);
const time = (n: number) =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(n);
function IconButton({
  title,
  children,
  onClick,
  active,
  disabled,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function FormModal({
  children,
  onSubmit,
  button = '保存',
}: {
  children: ReactNode;
  onSubmit: (data: FormData) => void;
  button?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const initial = useRef('');
  useEffect(() => {
    if (form.current) initial.current = inputState(form.current);
  }, []);
  function trackInput() {
    if (form.current)
      form.current.dataset.dirty = String(inputState(form.current) !== initial.current);
  }
  return (
    <form
      ref={form}
      data-dirty="false"
      className="dialog-form"
      onInput={trackInput}
      onChange={trackInput}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      {children}
      <button className="button primary" type="submit">
        {button}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
function verifyObjects(
  engine: NotebookEngine,
  noteId: string,
  expected: { id: string; version: string }[],
) {
  const objects = engine.getNote(noteId).pages.flatMap((p) => p.objects);
  if (
    expected.some(
      (old) => !objects.some((o) => o.id === old.id && !o.deleted && o.version === old.version),
    )
  )
    throw new Error('原稿已在预览期间改变。输入已保留，请重新打开最新内容后确认。');
}
function effectiveBlockObjects(engine: NotebookEngine, note: Note, blockId: string) {
  const block = note.blocks.find((b) => b.id === blockId);
  if (!block) return [];
  const visible = new Set(note.pages.flatMap((p) => visibleObjects(p)).map((o) => o.id));
  return [
    ...new Set([
      ...block.objectIds.filter((id) => visible.has(id)),
      ...block.segments
        .filter((s) => !s.deleted)
        .flatMap((s) => engine.findCorrespondence(note.id, s.id).objectIds),
    ]),
  ];
}
function ConflictVisual({
  engine,
  conflict,
  incoming = false,
}: {
  engine: NotebookEngine;
  conflict: Conflict;
  incoming?: boolean;
}) {
  if (conflict.kind !== 'object')
    return <pre>{incoming ? conflict.incoming : conflict.current}</pre>;
  const note = engine.state.notes.find((n) => n.id === conflict.noteId),
    page = note?.pages.find((p) => p.objects.some((o) => o.id === conflict.objectId)),
    object = page?.objects.find((o) => o.id === conflict.objectId);
  if (!object || !page)
    return <div className="conflict-object-missing">原始内容已保留在工程历史</div>;
  const op = engine.project.operations.find((o) => o.id === conflict.incomingEventId);
  const deletion = incoming && (op?.type === 'object.delete' || op?.type === 'segment.delete');
  const preview: PaperObject = {
    ...object,
    ...(incoming && op?.payload.changes ? op.payload.changes : {}),
    id: 'conflict-preview',
    deleted: false,
    revisionId: undefined,
    replacesObjectIds: undefined,
  };
  return (
    <div className={deletion ? 'deletion-preview' : 'object-conflict-preview'}>
      <PaperPreview page={{ ...page, objects: [preview] }} objectIds={[preview.id]} />
      {deletion && <span>删除此内容</span>}
    </div>
  );
}
function App() {
  const w = useWorkspace();
  const e = w.engine;
  const [view, setView] = useState<View>('paper');
  const [selectedNote, setSelectedNote] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [mode, setMode] = useState<'a' | 'b' | 'split'>('a');
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#3f3b42');
  const [penWidth, setPenWidth] = useState(2.4);
  const [layer, setLayer] = useState('ink');
  const [selected, setSelected] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState<string[]>([]);
  const [activeBlock, setActiveBlock] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [search, setSearch] = useState('');
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(
    () => matchMedia('(max-width: 760px)').matches,
  );
  const sidebarElement = useRef<HTMLElement>(null);
  const mainElement = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState('');
  const [showBlocks, setShowBlocks] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [reviewId, setReviewId] = useState('');
  const [reviewMode, setReviewMode] = useState<'a' | 'b' | 'split'>('b');
  const [reviewAll, setReviewAll] = useState(false);
  const writing = useRef(false);
  const sectionOrigin = useRef<View>('paper');
  const searchInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    imageInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null);
  const currentSources = useRef<SourceRecord[]>([]);
  const sourceBusy = useRef(new Set<string>());
  const note = selectedNote ? e?.state.notes.find((n) => n.id === selectedNote) : e?.state.notes[0];
  const page = note?.pages[Math.min(pageIndex, note.pages.length - 1)];
  const editable = w.role === 'tablet';
  const settings = e?.state.settings ?? {};
  const reviewSettings = (settings.reviewSettings ?? {
    dailyLimit: 20,
    algorithm: 'adaptive',
  }) as ReviewSettings;
  const assessments = Object.entries(settings)
    .filter(([k, v]) => k.startsWith('review-event:') && v)
    .map(([id, v]) => ({ id, ...(v as Omit<ReviewAssessmentEvent, 'id'>) }))
    .map((a) => ({ ...a, blockId: e?.resolveBlockId(a.blockId) ?? a.blockId }));
  const cards = Object.entries(settings)
    .filter(([k, v]) => k.startsWith('review:') && v)
    .map(([, v]) => v as ReviewCard)
    .filter((c) =>
      e?.state.notes.some((n) => n.id === c.noteId && n.blocks.some((b) => b.id === c.blockId)),
    )
    .map((c) => projectReviewEvents(c, assessments, reviewSettings));
  const due = dueReviews(cards, reviewSettings);
  const candidates = Object.entries(settings)
    .filter(([k, v]) => k.startsWith('candidate:') && v)
    .map(([key, value]) => ({
      key,
      ...(value as RecognitionResult & { noteId: string; segmentId?: string }),
    }))
    .filter((c) => {
      const n = e?.state.notes.find((n) => n.id === c.noteId);
      return (c.sourceObjectIds ?? [c.objectId]).every((id) =>
        n?.pages.some((p) =>
          p.objects.some(
            (o) =>
              o.id === id && !o.deleted && o.version === (c.sourceRevisions?.[id] ?? c.revision),
          ),
        ),
      );
    });
  const unmapped =
    e?.state.notes.flatMap((n) =>
      n.blocks.flatMap((b) =>
        b.segments
          .filter((s) => !s.deleted && s.source.status === 'unmapped')
          .map((s) => ({ note: n, block: b, segment: s })),
      ),
    ) ?? [];
  const conflicts = e?.state.conflicts.filter((c) => !c.resolved) ?? [];
  const notes = e?.state.notes ?? [];
  const visibleNotes = notes.filter(
    (n) =>
      (!folderFilter || n.folderId === folderFilter) &&
      `${n.title} ${n.tags.join(' ')} ${n.blocks.flatMap((b) => b.segments.map((s) => s.text)).join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const proofCount = candidates.length + unmapped.length + conflicts.length;
  const folderName = e?.state.folders.find(
    (f) => f.id === (view === 'paper' ? note?.folderId : folderFilter),
  )?.name;
  const viewTitle =
    view === 'review'
      ? '温故'
      : view === 'proof'
        ? '校对'
        : view === 'activity'
          ? '运行状态'
          : '所有笔记';
  const ViewIcon =
    view === 'review'
      ? History
      : view === 'proof'
        ? ScanLine
        : view === 'activity'
          ? GitBranch
          : BookOpen;
  const showSaveStatus =
    (view === 'paper' && !!note) || !['已存于本机', '正在打开'].includes(w.saveState);
  function canNavigate() {
    if (writing.current) {
      setNotice('请先抬笔，当前笔迹会保留');
      return false;
    }
    if (view === 'paper' && note) void w.closeNote();
    return true;
  }
  function returnToLibrary() {
    if (!canNavigate()) return;
    setView('library');
    setSidebar(false);
  }
  function navigateSection(next: View) {
    if (!canNavigate()) return;
    if (view === 'paper' || view === 'library') sectionOrigin.current = view;
    setView(next);
    setSidebar(false);
  }
  function showLibrary() {
    if (!canNavigate()) return;
    setView('library');
    setFolderFilter(null);
    setSearch('');
    setSidebar(false);
  }
  function resetNavigation() {
    setSelectedNote('');
    setView('paper');
    setPageIndex(0);
    setSelected([]);
    setHighlighted([]);
    setActiveBlock('');
    setFolderFilter(null);
    setSearch('');
    setReviewId('');
    setSidebar(false);
    sectionOrigin.current = 'paper';
  }
  function navigateBack() {
    if (writing.current) {
      setNotice('请先抬笔，当前笔迹会保留');
      return true;
    }
    if (sidebar) {
      setSidebar(false);
      return true;
    }
    if (view === 'paper' && note) {
      returnToLibrary();
      return true;
    }
    if (view !== 'paper' && view !== 'library') {
      setView(sectionOrigin.current === 'paper' && note ? 'paper' : 'library');
      return true;
    }
    return false;
  }
  useBackHandler(w.ready, navigateBack, 0);
  const isDrawerTop = useBackHandler(compactNavigation && sidebar, () => setSidebar(false), 90);
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const change = () => {
      setCompactNavigation(media.matches);
      if (!media.matches) setSidebar(false);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!compactNavigation || !sidebar) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const main = mainElement.current;
    if (main) main.inert = true;
    sidebarElement.current
      ?.querySelector<HTMLButtonElement>('button')
      ?.focus({ preventScroll: true });
    return () => {
      if (main) main.inert = false;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [compactNavigation, sidebar]);
  useEffect(() => {
    const back = () => dispatchBackHandlers();
    window.glossaNavigateBack = back;
    return () => {
      if (window.glossaNavigateBack === back) delete window.glossaNavigateBack;
    };
  }, []);
  useEffect(() => {
    if (!w.ready || !e || !selectedNote || note) return;
    resetNavigation();
    setView('library');
  }, [w.ready, e, selectedNote, note?.id]);
  function entryAction() {
    return notes.length ? (
      <button className="button" onClick={showLibrary}>
        查看笔记
        <ArrowRight size={16} />
      </button>
    ) : editable ? (
      <button className="button primary" onClick={() => newNote()}>
        一张新纸
        <Plus size={16} />
      </button>
    ) : (
      <button className="button primary" onClick={() => projectInput.current?.click()}>
        导入笔记
        <FileInput size={16} />
      </button>
    );
  }

  const sources = Object.entries(settings)
    .filter(([k, v]) => k.startsWith('source:') && v)
    .map(([, v]) => v as SourceRecord);
  currentSources.current = sources;
  useEffect(() => {
    const listener = (ev: Event) => w.setError((ev as CustomEvent<string>).detail);
    window.addEventListener('quietpaper-error', listener);
    return () => window.removeEventListener('quietpaper-error', listener);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  function openNote(n: Note) {
    if (!canNavigate()) return;
    setSelectedNote(n.id);
    setPageIndex(0);
    setView('paper');
    setSelected([]);
    setHighlighted([]);
    setActiveBlock('');
    setSidebar(false);
  }
  function newNote(spec: PaperSpec = {}) {
    if (!canNavigate()) return;
    w.transact((engine) => {
      const id = engine.createNote('未命名笔记', spec);
      setSelectedNote(id);
      setPageIndex(0);
      setView('paper');
      setMode('a');
      setTool('pen');
      setSelected([]);
      setHighlighted([]);
      setActiveBlock('');
      setFolderFilter(null);
      setSearch('');
      setSidebar(false);
    });
  }
  function jump(ids: string[]) {
    if (!note) return;
    const index = note.pages.findIndex((p) => p.objects.some((o) => ids.includes(o.id)));
    if (index < 0) {
      setNotice('尚无可靠对应，请先校对');
      return;
    }
    setPageIndex(index);
    setHighlighted(ids);
    setMode(mode === 'b' ? 'split' : mode);
    setView('paper');
    setModal(null);
  }
  function counterpart(object: PaperObject) {
    if (!note) return;
    const correspondence = e!.findCorrespondence(note.id, object.id);
    const b = note.blocks.find((b) =>
      b.segments.some((s) => correspondence.segmentIds.includes(s.id)),
    );
    const seg = b?.segments.find((s) => correspondence.segmentIds.includes(s.id));
    setModal({
      title: '原稿对象',
      content: (
        <div className="dialog-stack">
          <PaperPreview page={page!} objectIds={[object.id]} />
          <div className="object-meta">
            <span>
              {object.kind === 'stroke'
                ? '真实笔迹'
                : object.kind === 'formula'
                  ? '公式'
                  : '纸张对象'}
            </span>
            <span>
              {object.layerId.startsWith('revision:')
                ? '修订层'
                : object.layerId === 'ink'
                  ? '笔迹层'
                  : object.layerId}
            </span>
          </div>
          {seg?.source.status === 'exact' ? (
            <button
              className="button primary"
              onClick={() => {
                setActiveBlock(b!.id);
                setMode('split');
                setModal(null);
                setTimeout(
                  () =>
                    document
                      .getElementById('segment-' + seg.id)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                  100,
                );
              }}
            >
              对应结构 B <ArrowLeftRight size={16} />
            </button>
          ) : editable ? (
            <button className="button" onClick={() => proof([object.id], seg?.id)}>
              校对对应内容
              <ScanLine size={16} />
            </button>
          ) : (
            <div className="status-line">尚未确认对应关系</div>
          )}
          {editable && object.kind !== 'stroke' && object.kind !== 'image' && (
            <button className="button" onClick={() => editObject(object)}>
              编辑原稿
              <Type size={16} />
            </button>
          )}
        </div>
      ),
    });
  }
  function addText(kind: 'text' | 'formula', at = { x: 75, y: 100 }) {
    setModal({
      title: kind === 'formula' ? '写入公式' : '写入文字',
      content: (
        <FormModal
          onSubmit={(data) => {
            const text = String(data.get('text'));
            if (!text.trim()) return;
            w.transact((engine) =>
              engine.addText(
                note!.id,
                page!.id,
                text,
                {
                  x: at.x,
                  y: at.y,
                  width: Math.min(640, page!.width - at.x - 20),
                  height: kind === 'formula' ? 70 : Math.max(40, Math.ceil(text.length / 26) * 40),
                },
                kind,
              ),
            );
            setModal(null);
          }}
        >
          <textarea
            autoFocus
            name="text"
            rows={kind === 'formula' ? 3 : 5}
            required
            aria-label={kind === 'formula' ? '公式内容' : '文字内容'}
            placeholder={kind === 'formula' ? '∫ f(x) dx' : '…'}
            className={kind === 'formula' ? 'math' : ''}
          />
        </FormModal>
      ),
    });
  }
  function editObject(object: PaperObject) {
    const expected = { id: object.id, version: object.version };
    setModal({
      title: '编辑原稿',
      content: (
        <FormModal
          onSubmit={(data) => {
            const ok = w.transact((engine) => {
              verifyObjects(engine, note!.id, [expected]);
              engine.updateObject(note!.id, object.id, { text: String(data.get('text')) });
            });
            if (ok) setModal(null);
          }}
        >
          <textarea
            name="text"
            defaultValue={object.text}
            rows={5}
            autoFocus
            aria-label="原稿内容"
          />
        </FormModal>
      ),
    });
  }
  function proof(ids: string[], segmentId?: string, noteId = note?.id) {
    const n = e?.state.notes.find((n) => n.id === noteId);
    if (!n) return;
    const p = n.pages.find((p) => p.objects.some((o) => ids.includes(o.id)));
    if (!p) return;
    const candidate = candidates.find((c) =>
      (c.sourceObjectIds ?? [c.objectId]).some((id) => ids.includes(id)),
    );
    const existing = n.blocks
      .flatMap((b) => b.segments)
      .find((s) => s.id === (segmentId ?? candidate?.segmentId));
    if (candidate?.sourceObjectIds) ids = candidate.sourceObjectIds;
    const expectedObjects = n.pages
      .flatMap((p) => p.objects)
      .filter((o) => ids.includes(o.id))
      .map((o) => ({ id: o.id, version: o.version }));
    const segmentSnapshot = (s: Segment | undefined) =>
      s
        ? JSON.stringify({ chars: s.chars, source: s.source, deleted: s.deleted, kind: s.kind })
        : undefined;
    const expectedSegment = segmentSnapshot(existing);
    setModal({
      title: '校对原始记录',
      wide: true,
      content: (
        <FormModal
          button="确认对应"
          onSubmit={(data) => {
            const ok = w.transact((engine) => {
              verifyObjects(engine, n.id, expectedObjects);
              const latestSegment = engine
                .getNote(n.id)
                .blocks.flatMap((b) => b.segments)
                .find((s) => s.id === existing?.id);
              if (existing && segmentSnapshot(latestSegment) !== expectedSegment)
                throw new Error('结构内容已在校对期间改变。转录已保留，请刷新预览。');
              const text = String(data.get('text'));
              const kind = String(data.get('kind')) as 'text' | 'formula';
              if (existing) {
                engine.correctTranscription(n.id, existing.id, text, ids);
              } else {
                const matching = engine
                  .getNote(n.id)
                  .blocks.filter((b) => ids.every((id) => b.objectIds.includes(id)));
                const blockId =
                  matching.length === 1
                    ? matching[0].id
                    : engine.createBlock(n.id, kind === 'formula' ? '公式' : '已校对记录', ids);
                engine.recognize(n.id, blockId, ids, text, {
                  kind,
                  confirmed: true,
                  confidence: 1,
                });
              }
              for (const id of ids) engine.setSetting(`candidate:${id}`, null);
            });
            if (ok) {
              setModal(null);
              setNotice('已保存校对与对象对应');
            }
          }}
        >
          <PaperPreview page={p} objectIds={ids} />
          <label>
            转录内容
            <textarea
              name="text"
              rows={5}
              required
              defaultValue={candidate?.text ?? existing?.text ?? ''}
              aria-label="校对转录内容"
            />
          </label>
          <label>
            内容类型
            <select name="kind" defaultValue={existing?.kind === 'formula' ? 'formula' : 'text'}>
              <option value="text">文字</option>
              <option value="formula">公式</option>
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" required />
            我已核对原稿与转录内容
          </label>
        </FormModal>
      ),
    });
  }
  function erase(points: Point[], radius: number) {
    if (!note || !page) return;
    w.transact((engine) => {
      for (const o of visibleObjects(page)) {
        if (o.kind !== 'stroke' || !o.points) continue;
        const kept: Point[][] = [];
        let group: Point[] = [];
        let hit = false;
        for (const p of o.points) {
          if (points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < radius)) {
            hit = true;
            if (group.length) kept.push(group);
            group = [];
          } else group.push(p);
        }
        if (group.length) kept.push(group);
        if (!hit) continue;
        if (o.revisionId) {
          engine.splitRevisionStroke(note.id, o.id, kept, o.version);
          continue;
        }
        if (!kept.length) engine.deleteObject(note.id, o.id);
        else {
          const first = kept.shift()!;
          engine.updateObject(note.id, o.id, { points: first, bounds: pointsBounds(first) });
          for (const part of kept)
            engine.addStroke(note.id, page.id, part, {
              color: o.color,
              width: o.width,
              layerId: o.layerId,
            });
        }
      }
    });
  }
  function moveObjects(ids: string[], dx: number, dy: number) {
    w.transact((engine) => {
      for (const id of ids) {
        const o = page!.objects.find((o) => o.id === id);
        if (!o) continue;
        engine.updateObject(note!.id, id, {
          bounds: { ...o.bounds, x: o.bounds.x + dx, y: o.bounds.y + dy },
          ...(o.points
            ? { points: o.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }
            : {}),
        });
      }
    });
  }
  function tidySelected() {
    let changed = 0;
    const ok = w.transact((engine) => {
      for (const id of selected) {
        const o = engine
          .getNote(note!.id)
          .pages.flatMap((p) => p.objects)
          .find((o) => o.id === id && !o.deleted);
        if (!o?.points) continue;
        const points = straightenLine(o.points.map((p) => ({ ...p })));
        if (points.some((p, i) => p.x !== o.points![i].x || p.y !== o.points![i].y)) {
          engine.updateObject(note!.id, id, { points, bounds: pointsBounds(points) });
          changed++;
        }
      }
    });
    if (ok) setNotice(changed ? '线条已拉直' : '未发现可拉直的线条');
  }
  function createBlock() {
    if (!selected.length || !note) return;
    const ids = [...selected],
      expected = note.pages
        .flatMap((p) => p.objects)
        .filter((o) => ids.includes(o.id))
        .map((o) => ({ id: o.id, version: o.version }));
    setModal({
      title: '建立知识块',
      content: (
        <FormModal
          button="建立"
          onSubmit={(data) => {
            const ok = w.transact((engine) => {
              verifyObjects(engine, note.id, expected);
              engine.createBlock(note.id, String(data.get('title')), ids);
            });
            if (ok) {
              setModal(null);
              setMode('split');
              setSelected([]);
            }
          }}
        >
          <label>
            名称
            <input autoFocus name="title" required defaultValue="未命名知识块" />
          </label>
        </FormModal>
      ),
    });
  }
  function paperDialog() {
    setModal({
      title: '新纸张',
      content: (
        <FormModal
          button="添加纸张"
          onSubmit={(data) => {
            const spec: PaperSpec = {
              size: String(data.get('size')) as 'A4',
              orientation: String(data.get('orientation')) as 'portrait',
              template: String(data.get('template')) as 'dot',
              width: Number(data.get('width')),
              height: Number(data.get('height')),
            };
            w.transact((engine) => {
              engine.addPage(note!.id, spec);
              setPageIndex(note!.pages.length);
              setSelected([]);
              setMode('a');
            });
            setModal(null);
          }}
        >
          <div className="form-grid">
            <label>
              纸张
              <select name="size">
                <option>A4</option>
                <option>B5</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            <label>
              方向
              <select name="orientation">
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select>
            </label>
          </div>
          <label>
            纸面
            <select name="template">
              <option value="dot">点阵</option>
              <option value="blank">空白</option>
              <option value="ruled">横线</option>
              <option value="grid">方格</option>
            </select>
          </label>
          <div className="form-grid">
            <label>
              自定义宽
              <input name="width" type="number" min="100" max="20000" defaultValue="794" />
            </label>
            <label>
              自定义高
              <input name="height" type="number" min="100" max="20000" defaultValue="1123" />
            </label>
          </div>
        </FormModal>
      ),
    });
  }
  function manage() {
    if (!note) return;
    const before = { title: note.title, folderId: note.folderId, tags: [...note.tags] };
    setModal({
      title: '笔记归档',
      content: (
        <FormModal
          onSubmit={(data) => {
            const title = String(data.get('title')),
              folderId = String(data.get('folder')) || null,
              tags = String(data.get('tags'))
                .split(/[,，]/)
                .map((t) => t.trim())
                .filter(Boolean);
            const changes: { title?: string; folderId?: string | null; tags?: string[] } = {};
            if (title !== before.title) changes.title = title;
            if (folderId !== before.folderId) changes.folderId = folderId;
            if (JSON.stringify(tags) !== JSON.stringify(before.tags)) changes.tags = tags;
            const ok = w.transact((engine) => {
              const latest = engine.getNote(note.id);
              for (const key of Object.keys(changes) as (keyof typeof changes)[])
                if (JSON.stringify(latest[key]) !== JSON.stringify(before[key]))
                  throw new Error('归档信息已在其他设备改变，请刷新后确认。');
              if (Object.keys(changes).length) engine.manageNote(note.id, changes);
            });
            if (ok) setModal(null);
          }}
        >
          <label>
            标题
            <input name="title" defaultValue={note.title} required />
          </label>
          <label>
            文件夹
            <select name="folder" defaultValue={note.folderId ?? ''}>
              <option value="">未归档</option>
              {e!.state.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            标签
            <input name="tags" defaultValue={note.tags.join('，')} />
          </label>
          <div className="status-line">
            内容修改 · {date(note.modifiedAt)} {time(note.modifiedAt)}
          </div>
        </FormModal>
      ),
    });
  }
  function newFolder() {
    setModal({
      title: '新文件夹',
      content: (
        <FormModal
          button="创建"
          onSubmit={(data) => {
            w.transact((engine) =>
              engine.createFolder(String(data.get('name')), String(data.get('subject'))),
            );
            setModal(null);
          }}
        >
          <label>
            名称
            <input autoFocus name="name" required />
          </label>
          <label>
            学科
            <input name="subject" />
          </label>
        </FormModal>
      ),
    });
  }
  function learnHandwriting() {
    if (!note || !selected.length) return;
    const noteId = note.id;
    const ids = [...selected];
    const sources = note.pages.flatMap((p) => p.objects).filter((o) => ids.includes(o.id));
    if (sources.some((o) => o.kind !== 'stroke' || o.revisionId)) {
      setNotice('请只框选一个原始手写字的全部笔画');
      return;
    }
    const expected = Object.fromEntries(sources.map((o) => [o.id, o.version]));
    setModal({
      title: '学习选中字形',
      content: (
        <FormModal
          button="保存字形"
          onSubmit={(data) => {
            const ok = w.transact((engine) =>
              engine.learnHandwritingGlyph(noteId, ids, String(data.get('character')), expected),
            );
            if (ok) {
              setModal(null);
              setNotice('字形已保存，后续 B 修订可复用这组真实笔迹');
            }
          }}
        >
          {page && <PaperPreview page={page} objectIds={ids} />}
          <label>
            这个字是
            <input
              name="character"
              required
              autoFocus
              aria-label="字形对应字符"
              placeholder="例如：学"
            />
          </label>
          <label className="check-row">
            <input type="checkbox" required />
            我已选中这个字的全部笔画，并确认字符正确
          </label>
        </FormModal>
      ),
    });
  }
  function revisions() {
    const fingerprints = new Map(
      e!.state.corrections.map((c) => [c.id, e!.handwritingRevisionFingerprint(c.id)]),
    );
    setModal({
      title: '修订与历史',
      wide: true,
      content: (
        <div className="dialog-stack">
          {e!.state.corrections.filter((c) => c.noteId === note?.id).length === 0 && (
            <div className="empty compact">
              <History />
              <h3>没有待合并修订</h3>
            </div>
          )}
          {e!.state.corrections
            .filter((c) => c.noteId === note?.id)
            .map((c) => (
              <div className="revision-card" key={c.id}>
                <div className="eyebrow">
                  {c.mode === 'handwriting' ? '可编辑仿手写修订层' : '可编辑印刷修订层'}
                </div>
                <del>{c.before}</del>
                <p>{c.after}</p>
                <p>{c.reason}</p>
                <div className="button-row">
                  {editable && c.mode === 'printed' && !c.needsPlacement && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        if (
                          w.transact((engine) =>
                            engine.retryHandwritingRevision(c.id, fingerprints.get(c.id)),
                          )
                        ) {
                          setModal(null);
                          const result = w
                            .getEngine()
                            ?.state.corrections.find((item) => item.id === c.id);
                          setNotice(
                            result?.mode === 'handwriting'
                              ? '已生成可编辑仿手写修订'
                              : (result?.reason ?? '已重新检查字形样本'),
                          );
                        }
                      }}
                    >
                      重试仿手写
                      <PenLine size={15} />
                    </button>
                  )}
                  {editable && (
                    <button
                      className="button"
                      onClick={() => {
                        if (w.transact((engine) => engine.undoRevision(c.id))) setModal(null);
                      }}
                    >
                      独立撤销
                      <RotateCcw size={15} />
                    </button>
                  )}
                  {editable && (
                    <button
                      className="button"
                      onClick={() =>
                        setModal({
                          title: '合并此修订？',
                          content: (
                            <div className="dialog-stack">
                              <p>
                                合并后将清除修订来源与专门撤销记录，作为普通笔迹保留。此修订不能再独立撤销。
                              </p>
                              <p className="revision-preview">{c.after}</p>
                              <button
                                className="button primary"
                                onClick={() => {
                                  if (w.transact((engine) => engine.mergeRevision(c.id, true)))
                                    setModal(null);
                                }}
                              >
                                确认不可逆合并
                                <Check size={16} />
                              </button>
                            </div>
                          ),
                        })
                      }
                    >
                      合并到原稿
                      <Layers size={15} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          {note?.blocks.map((b) => (
            <details key={b.id}>
              <summary>
                {b.title} · {b.versions.length} 个版本
              </summary>
              {b.versions
                .slice()
                .reverse()
                .map((v) => (
                  <div className="version-row" key={v.eventId}>
                    <span>
                      {date(v.at)} {time(v.at)}
                    </span>
                    <p>{v.text}</p>
                  </div>
                ))}
            </details>
          ))}
        </div>
      ),
    });
  }
  function deleteSelected() {
    if (!selected.length || !note) return;
    const noteId = note.id,
      ids = [...selected];
    const expectedObjects = note.pages
      .flatMap((p) => p.objects)
      .filter((o) => ids.includes(o.id))
      .map((o) => ({ id: o.id, version: o.version }));
    const expectedSegments = note.blocks
      .flatMap((b) => b.segments)
      .filter((s) => s.source.objectIds.some((id) => ids.includes(id)))
      .map((s) => ({ id: s.id, chars: JSON.stringify(s.chars), deleted: s.deleted }));
    const linked = sources.filter((s) => ids.includes(s.paperObjectId) && s.link.mode === 'linked');
    function verifySelection(engine: NotebookEngine) {
      verifyObjects(engine, noteId, expectedObjects);
      const segments = engine.getNote(noteId).blocks.flatMap((b) => b.segments);
      if (
        expectedSegments.some(
          (old) =>
            !segments.some(
              (s) =>
                s.id === old.id &&
                JSON.stringify(s.chars) === old.chars &&
                s.deleted === old.deleted,
            ),
        )
      )
        throw new Error('对应结构已在预览期间改变，请重新确认删除');
    }
    async function remove(choice: 'detach' | 'delete-source') {
      const updates: SourceRecord[] = [];
      const accepted = w.transact((engine) => {
        verifySelection(engine);
        for (const original of linked) {
          const live = engine.state.settings['source:' + original.link.id] as
            | SourceRecord
            | undefined;
          if (!live || sourceStamp(live) !== sourceStamp(original))
            throw new Error('源文件状态已在预览期间改变，请重新确认删除');
          const staged = queueCurrentPaper(live, captureSourcePaper(engine, live));
          updates.push({ ...staged, link: deleteLinkedObject(staged.link, choice).link });
        }
        for (const update of updates) engine.setSetting('source:' + update.link.id, update);
        for (const id of ids) engine.deleteObject(noteId, id);
      });
      if (!accepted) return;
      try {
        await w.waitForSave();
        setSelected([]);
        setModal(null);
        setNotice(
          choice === 'detach' ? '已移除纸张内容，源文件保留' : '源对象删除已安全排队，快照保留',
        );
        if (choice === 'delete-source') for (const update of updates) void processSource(update);
      } catch (error) {
        w.setError(String(error));
      }
    }
    if (linked.length) {
      setModal({
        title: '移除关联对象',
        content: (
          <div className="dialog-stack">
            <p>
              {ids.length} 个纸张对象，其中 {linked.length} 个关联源对象。
            </p>
            {linked.map((source) => (
              <div key={source.link.id}>{source.document.name}</div>
            ))}
            <button className="button" onClick={() => void remove('detach')}>
              仅移除纸张内容与关联
            </button>
            <button className="button danger" onClick={() => void remove('delete-source')}>
              同时删除源文件对应对象
            </button>
          </div>
        ),
      });
      return;
    }
    setModal({
      title: '删除选中内容？',
      content: (
        <div className="dialog-stack">
          <p>{ids.length} 个对象及已确认的对应内容会同步删除，版本记录保留。</p>
          <button
            className="button danger"
            onClick={() => {
              if (
                w.transact((engine) => {
                  verifySelection(engine);
                  ids.forEach((id) => engine.deleteObject(noteId, id));
                })
              ) {
                setSelected([]);
                setModal(null);
              }
            }}
          >
            确认删除
            <Trash2 size={15} />
          </button>
        </div>
      ),
    });
  }
  function importSource(name: string, text: string, reply?: NativeReply) {
    try {
      if (!note || !page) throw new Error('请先打开需要插入对象的纸张');
      const document = openNative(name, text),
        noteId = note.id,
        pageId = page.id,
        pageWidth = page.width;
      setModal({
        title: document.name,
        wide: true,
        content: (
          <div className="dialog-stack source-objects">
            {document.objects.map((object) => (
              <div className="source-object" key={object.id}>
                <pre>{object.text}</pre>
                <button
                  className="button"
                  onClick={() => {
                    const accepted = w.transact((engine) => {
                      const objectId = engine.addText(
                        noteId,
                        pageId,
                        object.text,
                        {
                          x: 75,
                          y: 150,
                          width: Math.min(640, pageWidth - 120),
                          height: Math.max(50, Math.ceil(object.text.length / 28) * 35),
                        },
                        object.kind === 'formula' ? 'formula' : 'text',
                      );
                      const link = createNativeLink(document, object.id, {
                        offlineTimeoutMs:
                          Number(engine.state.settings.sourceOfflineDays ?? 30) * 86400000,
                      });
                      engine.setSetting('source:' + link.id, {
                        document,
                        link,
                        paperObjectId: objectId,
                        noteId,
                        pageId,
                        uri: reply?.uri,
                        sha256: reply?.sha256,
                        ownerDeviceId: w.installationId,
                      } satisfies SourceRecord);
                    });
                    if (accepted) {
                      setModal(null);
                      setNotice('已插入原生源对象');
                    }
                  }}
                >
                  插入并关联
                  <Plus size={15} />
                </button>
              </div>
            ))}
          </div>
        ),
      });
    } catch (error) {
      w.setError(String(error));
    }
  }
  async function openSource() {
    if (window.QuietPaperNative) {
      try {
        const reply = await nativeRequest('openDocument');
        importSource(reply.name!, reply.text!, reply);
      } catch (err) {
        w.setError(String(err));
      }
    } else fileInput.current?.click();
  }
  function liveSource(id: string): SourceRecord | undefined {
    return w.getEngine()?.state.settings['source:' + id] as SourceRecord | undefined;
  }
  const sourceStamp = (record: SourceRecord) => JSON.stringify(record);
  const sourceContentStamp = (record: SourceRecord) =>
    JSON.stringify({ ...record, link: { ...record.link, lastSourceContact: undefined } });
  async function publishSource(
    next: SourceRecord,
    expected: SourceRecord,
    captured?: PaperCapture,
    applyPaper?: (engine: NotebookEngine) => void,
  ) {
    let applied = false;
    const accepted = w.transact((engine) => {
      const current = engine.state.settings['source:' + expected.link.id] as
        | SourceRecord
        | undefined;
      if (
        !current ||
        sourceStamp(current) !== sourceStamp(expected) ||
        (captured && !captureStillCurrent(engine, current, captured))
      )
        return;
      applyPaper?.(engine);
      engine.setSetting('source:' + next.link.id, next);
      applied = true;
    });
    if (!accepted || !applied) return false;
    await w.waitForSave();
    return true;
  }
  async function retainSourcePending(id: string, message?: string) {
    const current = liveSource(id),
      engine = w.getEngine();
    if (!current || !engine || current.link.mode !== 'linked') return;
    const next = queueCurrentPaper(current, captureSourcePaper(engine, current));
    if (message) next.link.writeError = message;
    if (sourceStamp(next) !== sourceStamp(current)) await publishSource(next, current);
  }
  async function processSource(input: SourceRecord) {
    let record = liveSource(input.link.id),
      engine = w.getEngine();
    if (
      !editable ||
      !window.QuietPaperNative ||
      !record?.uri ||
      record.ownerDeviceId !== w.installationId ||
      record.link.mode !== 'linked' ||
      !engine ||
      sourceBusy.current.has(record.link.id)
    )
      return;
    const id = record.link.id;
    const requestedUri = record.uri,
      requestedOwner = record.ownerDeviceId;
    sourceBusy.current.add(id);
    let lastVerifiedContact: number | undefined;
    const sourceRequest = async (...args: Parameters<typeof nativeRequest>) => {
      const reply = await nativeRequest(...args);
      if (reply.sourceReachable || args[0] === 'readDocument') lastVerifiedContact = Date.now();
      return reply;
    };
    try {
      // Persist the actual B/A intent before any source read or write can fail.
      const staged = queueCurrentPaper(record, captureSourcePaper(engine, record));
      if (sourceStamp(staged) !== sourceStamp(record)) {
        if (!(await publishSource(staged, record))) return;
        record = liveSource(id)!;
      }
      await w.waitForSave();
      engine = w.getEngine();
      if (!engine || !record) return;
      let captured = captureSourcePaper(engine, record);
      let reply = await sourceRequest('readDocument', [record.uri!]);
      const afterRead = liveSource(id),
        readEngine = w.getEngine();
      if (
        !afterRead ||
        !readEngine ||
        sourceStamp(afterRead) !== sourceStamp(record) ||
        !captureStillCurrent(readEngine, afterRead, captured)
      ) {
        await retainSourcePending(id, '读取源文件期间出现新修改，保留待写回');
        return;
      }
      if (typeof reply.text !== 'string' || !reply.sha256)
        throw new Error('源文件读取缺少完整内容或版本指纹，未执行写入');
      const nativePending = await sourceRequest('getPendingSource', [record.uri!]);
      const afterPending = liveSource(id),
        pendingEngine = w.getEngine();
      if (
        !afterPending ||
        !pendingEngine ||
        sourceStamp(afterPending) !== sourceStamp(record) ||
        !captureStillCurrent(pendingEngine, afterPending, captured)
      ) {
        await retainSourcePending(id, '读取原生待写回版本期间出现新修改，保留排队');
        return;
      }
      if (nativePending.pending) {
        const known = verifyNativePending(record, nativePending);
        const unchangedBase =
          known &&
          reply.text === known.expectedSourceText &&
          reply.sha256 === known.expectedSourceSha256;
        const alreadyWritten = known && reply.text === known.text;
        if (record.pendingSource || !known || (!unchangedBase && !alreadyWritten)) {
          const observed = record.pendingSource
            ? refreshPendingSourceRead(
                record,
                reply.name ?? record.document.name,
                reply.text,
                reply.sha256,
              )
            : record;
          const blocked = previewNativePending(
            observed,
            nativePending,
            reply.text,
            reply.sha256,
            !known
              ? '原生待写回版本不属于已确认的本地写入计划；保留双方，请预览后选择。'
              : '原生待写回的源版本已变化或仍待对象定位；保留双方，请预览后选择。',
          );
          if (sourceContentStamp(blocked) !== sourceContentStamp(record))
            await publishSource(blocked, record, captured);
          return;
        }
        // Finish the older, proven intent before considering a newer B revision.
        await sourceRequest('saveDocumentVersioned', [
          record.uri!,
          known.text,
          reply.sha256,
          nativePending.sha256!,
        ]);
        const verified = await sourceRequest('readDocument', [record.uri!]);
        const retryLive = liveSource(id),
          retryEngine = w.getEngine();
        if (
          !retryLive ||
          !retryEngine ||
          sourceStamp(retryLive) !== sourceStamp(record) ||
          !captureStillCurrent(retryEngine, retryLive, captured)
        ) {
          await retainSourcePending(id, '原生旧计划已返回，后续修改仍排队待确认');
          return;
        }
        if (verified.text !== known.text || !verified.sha256)
          throw new Error('旧原生待写回版本未得到完整源内容确认');
        reply = verified;
        if (known.kind === 'explicit') {
          const acknowledged = acknowledgeNativeResolution(record, verified.text!, verified.sha256);
          await publishSource(acknowledged, record, captured);
          return;
        }
      } else if (record.nativeResolution) {
        if (reply.text === record.nativeResolution.text) {
          await publishSource(
            acknowledgeNativeResolution(record, reply.text, reply.sha256),
            record,
            captured,
          );
          return;
        }
        const blocked = previewNativePending(
          record,
          { text: record.nativeResolution.text, sha256: '' },
          reply.text,
          reply.sha256,
          '原生决议未完成或源已再次改变；保留原决议与源内容，请重新预览。',
        );
        if (sourceContentStamp(blocked) !== sourceContentStamp(record))
          await publishSource(blocked, record, captured);
        return;
      }
      if (typeof reply.text !== 'string' || !reply.sha256)
        throw new Error('源版本核验不完整，保留待写回计划');
      if (record.pendingNative) {
        const cleared = { ...record };
        delete cleared.pendingNative;
        if (cleared.link.status === 'conflict' && !cleared.link.conflict)
          cleared.link = { ...cleared.link, status: cleared.pendingSource ? 'missing' : 'pending' };
        if (!(await publishSource(cleared, record, captured))) return;
        record = liveSource(id)!;
      }
      if (record.pendingSource) {
        const observed = refreshPendingSourceRead(
          record,
          reply.name ?? record.pendingSource.document.name,
          reply.text,
          reply.sha256,
        );
        if (sourceContentStamp(observed) !== sourceContentStamp(record))
          await publishSource(observed, record, captured);
        return;
      }
      const identified = identifySourceRead(
        record,
        reply.name ?? record.document.name,
        reply.text,
        reply.sha256,
      );
      if (identified.pendingSource) {
        const next = {
          ...record,
          pendingSource: identified.pendingSource,
          link: { ...record.link, status: 'missing' as const },
        };
        await publishSource(next, record, captured);
        return;
      }
      if (identified.adoptedWrite) {
        const adopted = queueCurrentPaper(identified.adoptedWrite, captured);
        if (!(await publishSource(adopted, record, captured))) return;
        record = liveSource(id)!;
        if (record.link.mode !== 'linked') return;
        engine = w.getEngine()!;
        captured = captureSourcePaper(engine, record);
      }
      const fresh = identified.document!;
      const result = reconcileNativeLink(record.link, fresh);
      if (result.conflict) {
        await publishSource(
          { ...record, document: fresh, link: result.link, sha256: reply.sha256 },
          record,
          captured,
        );
        return;
      }
      let sha = reply.sha256;
      if (result.document.text !== reply.text) {
        // The write plan survives a crash between native save and its acknowledgment.
        const planned = {
          ...record,
          document: fresh,
          sha256: reply.sha256,
          plannedWrite: {
            id: crypto.randomUUID(),
            document: result.document,
            link: result.link,
            expectedText: reply.text,
            expectedSha256: reply.sha256,
            paperToken: captured.token,
          },
        };
        if (!(await publishSource(planned, record, captured))) return;
        record = liveSource(id)!;
        const beforeWrite = w.getEngine();
        if (!beforeWrite || !captureStillCurrent(beforeWrite, record, captured)) {
          await retainSourcePending(id, '写回前出现新修改，待重新协调');
          return;
        }
        const saved = await sourceRequest('saveDocumentVersioned', [
          record.uri!,
          serializeNative(result.document),
          reply.sha256,
          '',
        ]);
        if (!saved.sha256) throw new Error('源文件未返回写入确认，待重新核验');
        sha = saved.sha256;
      }
      const latest = liveSource(id),
        currentEngine = w.getEngine();
      if (
        !latest ||
        !currentEngine ||
        sourceStamp(latest) !== sourceStamp(record) ||
        !captureStillCurrent(currentEngine, latest, captured)
      ) {
        await retainSourcePending(id, '源写入已返回，纸张出现新修改；保留写入计划待核验');
        return;
      }
      const next = { ...record, document: result.document, link: result.link, sha256: sha };
      delete next.plannedWrite;
      delete next.pendingSource;
      if (sourceContentStamp(next) !== sourceContentStamp(record))
        await publishSource(next, record, captured, (current) => {
          if (result.link.deleted) {
            if (!captured.deleted) current.deleteObject(record!.noteId, record!.paperObjectId);
          } else if (!captured.deleted && captured.text !== result.link.paperContent)
            current.updateObject(record!.noteId, record!.paperObjectId, {
              text: result.link.paperContent,
            });
        });
    } catch (error) {
      const failure = error as Error & { reply?: NativeReply };
      const latest = liveSource(id),
        current = w.getEngine();
      // Relinking or restoring while I/O is pending invalidates old source observations.
      if (latest && (latest.uri !== requestedUri || latest.ownerDeviceId !== requestedOwner))
        return;
      if (latest && current && latest.link.mode === 'linked') {
        const next = queueCurrentPaper(latest, captureSourcePaper(current, latest));
        next.link = recordSourceFailure(next.link, failure.reply, Date.now(), lastVerifiedContact);
        next.link.writeError = failure.message;
        try {
          await publishSource(next, latest);
        } catch (saveError) {
          w.setError('源文件修改仍保留于本机：' + String(saveError));
        }
      }
      if (!failure.reply?.unavailable) w.setError('源文件写回待处理：' + failure.message);
    } finally {
      sourceBusy.current.delete(id);
    }
  }
  function sourceNativeConflictDialog(record: SourceRecord) {
    const preview = record.pendingNative,
      engine = w.getEngine();
    if (!preview || !engine) return;
    const captured = captureSourcePaper(engine, record),
      expected = sourceStamp(record);
    async function choose(text: string) {
      const live = liveSource(record.link.id),
        current = w.getEngine();
      if (
        !live ||
        !current ||
        sourceStamp(live) !== expected ||
        !captureStillCurrent(current, live, captured)
      ) {
        w.setError('原生待写回预览已变化，请刷新；手动决议已保留');
        return;
      }
      try {
        const intent = beginNativeResolution(live, text);
        if (!(await publishSource(intent, live, captured))) return;
        const staged = liveSource(record.link.id)!;
        await nativeRequest('saveDocumentVersioned', [
          staged.uri!,
          text,
          preview!.sourceSha256,
          preview!.sha256,
        ]);
        const actual = await nativeRequest('readDocument', [staged.uri!]);
        const latest = liveSource(record.link.id),
          active = w.getEngine();
        if (
          !latest ||
          !active ||
          sourceStamp(latest) !== sourceStamp(staged) ||
          !captureStillCurrent(active, latest, captured)
        ) {
          await retainSourcePending(record.link.id, '原生决议已返回，后续纸张修改保留待核验');
          return;
        }
        if (typeof actual.text !== 'string' || !actual.sha256)
          throw new Error('原生决议缺少完整写入确认');
        const confirmed = acknowledgeNativeResolution(latest, actual.text, actual.sha256);
        if (await publishSource(confirmed, latest, captured)) {
          setModal(null);
          setNotice('原生双版本已保留，请重新定位对应对象');
        }
      } catch (error) {
        w.setError('原生决议仍保留：' + String(error));
      }
    }
    setModal({
      title: '原生待写回版本',
      wide: true,
      content: (
        <div className="dialog-stack">
          <p>{preview.reason}</p>
          <div className="conflict-sides">
            <div>
              <h3>原生待写回全文</h3>
              <pre>{preview.text}</pre>
              <button className="button" onClick={() => void choose(preview.text)}>
                采用待写回版本
              </button>
              <button
                className="text-button"
                onClick={() => downloadText('待写回-' + record.document.name, preview.text)}
              >
                导出此版本
                <ArrowDownToLine size={14} />
              </button>
            </div>
            <div>
              <h3>当前源文件全文</h3>
              <pre>{preview.sourceText}</pre>
              <button className="button" onClick={() => void choose(preview.sourceText)}>
                保留当前源文件
              </button>
              <button
                className="text-button"
                onClick={() => downloadText('源文件-' + record.document.name, preview.sourceText)}
              >
                导出源版本
                <ArrowDownToLine size={14} />
              </button>
            </div>
          </div>
          <FormModal
            button="确认全文决议"
            onSubmit={(data) => void choose(String(data.get('text')))}
          >
            <label>
              协调全文
              <textarea
                name="text"
                rows={8}
                defaultValue={record.nativeResolution?.text ?? preview.text}
              />
            </label>
          </FormModal>
        </div>
      ),
    });
  }
  function sourceIdentityDialog(record: SourceRecord) {
    if (!record.pendingSource) return;
    const expected = sourceStamp(record);
    setModal({
      title: '重新定位源对象',
      wide: true,
      content: (
        <div className="dialog-stack source-objects">
          <p>{record.pendingSource.reason}</p>
          <pre>{record.link.baseContent}</pre>
          {record.pendingSource.document.objects.map((object) => (
            <div className="source-object" key={object.id}>
              <pre>{object.text}</pre>
              <button
                className="button"
                onClick={async () => {
                  const live = liveSource(record.link.id);
                  if (!live || sourceStamp(live) !== expected) {
                    w.setError('源对象预览已变化，请重新打开');
                    return;
                  }
                  try {
                    const chosen = bindSourceObject(live, object.id);
                    if (await publishSource(chosen, live)) {
                      setModal(null);
                      void processSource(chosen);
                    }
                  } catch (error) {
                    w.setError(String(error));
                  }
                }}
              >
                确认这是对应对象
                <Check size={15} />
              </button>
            </div>
          ))}
        </div>
      ),
    });
  }
  async function relocateSource(record: SourceRecord) {
    try {
      const reply = await nativeRequest('openDocument');
      if (typeof reply.text !== 'string' || !reply.uri) throw new Error('未获得源文件');
      const live = liveSource(record.link.id);
      if (!live) return;
      const document = openNative(reply.name ?? live.document.name, reply.text, live.document.id);
      const next = {
        ...live,
        uri: reply.uri,
        ownerDeviceId: w.installationId,
        pendingSource: {
          document,
          sha256: reply.sha256,
          reason: '请核对原记录并选择此文件中的对应对象',
        },
        link: { ...live.link, status: 'missing' as const },
      };
      if (await publishSource(next, live)) sourceIdentityDialog(next);
    } catch (error) {
      w.setError(String(error));
    }
  }
  function sourceConflictDialog(record: SourceRecord) {
    if (!record.link.conflict) return;
    const preview = record.link.conflict,
      engine = w.getEngine();
    if (!engine) return;
    const captured = captureSourcePaper(engine, record),
      expected = sourceStamp(record);
    if (record.link.deleted && record.link.queued.some((op) => op.kind === 'delete-source')) {
      async function decideDeletion(removeSource: boolean) {
        const live = liveSource(record.link.id),
          current = w.getEngine();
        if (
          !live ||
          !current ||
          sourceStamp(live) !== expected ||
          !captureStillCurrent(current, live, captured)
        ) {
          w.setError('源删除预览已变化，请重新确认');
          return;
        }
        try {
          const next = removeSource
            ? confirmSourceDeletion(live)
            : { ...live, link: deleteLinkedObject(live.link, 'detach').link };
          if (await publishSource(next, live, captured)) {
            setModal(null);
            if (removeSource) void processSource(next);
          }
        } catch (error) {
          w.setError(String(error));
        }
      }
      setModal({
        title: '源对象已在删除前改变',
        wide: true,
        content: (
          <div className="dialog-stack">
            <p>源文件中有较新的内容。纸张删除与源文件删除分别保留。</p>
            <div className="conflict-sides">
              <div>
                <h3>删除前快照</h3>
                <pre>{preview.base}</pre>
              </div>
              <div>
                <h3>当前源内容</h3>
                <pre>{preview.source}</pre>
              </div>
            </div>
            <button className="button" onClick={() => void decideDeletion(false)}>
              保留源文件，取消源删除
            </button>
            <button className="button danger" onClick={() => void decideDeletion(true)}>
              确认删除源对象
            </button>
          </div>
        ),
      });
      return;
    }
    async function choose(text: string) {
      const live = liveSource(record.link.id),
        current = w.getEngine();
      if (
        !live ||
        !current ||
        sourceStamp(live) !== expected ||
        !captureStillCurrent(current, live, captured)
      ) {
        w.setError('冲突预览后内容再次变化，请刷新预览；手动输入已保留');
        return;
      }
      try {
        const next = chooseSourceConflict(live, text);
        if (
          await publishSource(next, live, captured, (active) => {
            if (!captured.deleted && captured.text !== text)
              active.updateObject(live.noteId, live.paperObjectId, { text });
          })
        ) {
          setModal(null);
          void processSource(next);
        }
      } catch (error) {
        w.setError(String(error));
      }
    }
    setModal({
      title: preview.kind === 'unverified-correspondence' ? '确认源对象对应' : '源文件冲突',
      wide: true,
      content: (
        <div className="dialog-stack">
          <p>{preview.reason}</p>
          <div className="conflict-sides">
            <div>
              <h3>纸张内容</h3>
              <pre>{preview.paper}</pre>
              <button className="button" onClick={() => void choose(preview.paper)}>
                保留纸张内容
              </button>
            </div>
            <div>
              <h3>源文件内容</h3>
              <pre>{preview.source}</pre>
              <button className="button" onClick={() => void choose(preview.source)}>
                采用源文件内容
              </button>
            </div>
          </div>
          <FormModal
            button="采用修订并写回"
            onSubmit={(data) => void choose(String(data.get('text')))}
          >
            <label>
              手动协调
              <textarea name="text" defaultValue={preview.paper} rows={5} />
            </label>
          </FormModal>
        </div>
      ),
    });
  }
  useEffect(() => {
    if (!editable || !window.QuietPaperNative) return;
    const run = () => currentSources.current.forEach((s) => void processSource(s));
    const timer = setInterval(run, 30000);
    window.addEventListener('focus', run);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', run);
    };
  }, [editable, e]);
  function exportDialog() {
    setModal({
      title: '导出与恢复',
      content: (
        <div className="dialog-stack">
          <button
            className="button primary"
            onClick={() => {
              downloadText((note?.title ?? '笺注') + '.glossa', w.getEngine()!.exportProject());
              setModal(null);
            }}
          >
            完整原生工程包
            <ArrowDownToLine size={17} />
          </button>
          <button
            className="button"
            onClick={() => {
              setModal(null);
              projectInput.current?.click();
            }}
          >
            导入工程包
            <FileInput size={17} />
          </button>
          <button
            className="button"
            onClick={() => {
              setModal(null);
              setShowRecovery(true);
            }}
          >
            本地恢复副本
            <History size={17} />
          </button>
          {note && (
            <button
              className="button"
              onClick={async () => {
                const { exportStructuredMarkdown } = await import('./export');
                downloadText(
                  (note?.title ?? '笔记') + '.md',
                  exportStructuredMarkdown(note!),
                  'text/markdown',
                );
              }}
            >
              导出 Markdown
              <FileText size={17} />
            </button>
          )}
          {note && (
            <button
              className="button"
              onClick={async () => {
                const { exportReadingHtml } = await import('./export');
                downloadText(
                  (note?.title ?? '笔记') + '-阅读.html',
                  exportReadingHtml(note!),
                  'text/html',
                );
              }}
            >
              离线阅读快照
              <BookOpen size={17} />
            </button>
          )}
        </div>
      ),
    });
  }
  async function runtimeDiagnosticsDialog() {
    try {
      const reply = await nativeRequest('getRuntimeDiagnostics');
      if (!Array.isArray(reply.runtime)) throw new Error('runtime-diagnostics-invalid');
      setModal({
        title: '窗口记录',
        content: (
          <div className="dialog-stack runtime-records">
            {reply.runtime?.length ? (
              [...reply.runtime].reverse().map((entry, index) => (
                <article className="source-object" key={`${entry.at}:${index}`}>
                  <strong>{entry.didCrash ? '异常退出' : '系统终止'}</strong>
                  <time
                    dateTime={
                      entry.at <= 8640000000000000 ? new Date(entry.at).toISOString() : undefined
                    }
                  >
                    {entry.at <= 8640000000000000
                      ? new Date(entry.at).toLocaleString()
                      : '时间不可用'}
                  </time>
                  <dl>
                    <dt>应用</dt>
                    <dd>Glossa {entry.appVersion}</dd>
                    <dt>Android API</dt>
                    <dd>{entry.osApi}</dd>
                    <dt>书写组件</dt>
                    <dd>{entry.webViewVersion}</dd>
                  </dl>
                </article>
              ))
            ) : (
              <div className="empty">
                <h2>暂无窗口记录</h2>
              </div>
            )}
          </div>
        ),
      });
    } catch {
      w.setError('窗口记录暂不可读，已有记录仍保留在本机');
    }
  }
  function settingsDialog() {
    setModal({
      title: '偏好与同步',
      wide: true,
      content: <SettingsPanel workspace={w} onClose={() => setModal(null)} onNotice={setNotice} />,
    });
  }
  function draftRecovery() {
    setModal({
      title: '待恢复笔迹',
      content: (
        <div className="dialog-stack">
          {w.pendingDrafts.map((entry) => (
            <div className="revision-card" key={entry.key}>
              <div className="eyebrow">
                {date(entry.draft.updatedAt ?? Date.now())} ·{' '}
                {time(entry.draft.updatedAt ?? Date.now())}
              </div>
              <p>{entry.draft.points.length} 个原始采样点</p>
              <div className="button-row">
                {editable && (
                  <button
                    className="button primary"
                    onClick={() =>
                      setModal({
                        title: '恢复这笔原稿？',
                        content: (
                          <div className="dialog-stack">
                            <p>
                              请确认原窗口已经停止书写。恢复会保留压感、倾斜、图层和原纸张位置。
                            </p>
                            <button
                              className="button primary"
                              onClick={() =>
                                void w
                                  .recoverDraft(entry.key, true)
                                  .then(() => {
                                    setModal(null);
                                    setNotice('原始笔迹已恢复');
                                  })
                                  .catch((err) => w.setError(String(err)))
                              }
                            >
                              原窗口已停止，恢复
                              <RotateCcw size={16} />
                            </button>
                          </div>
                        ),
                      })
                    }
                  >
                    恢复到原纸张
                    <RotateCcw size={15} />
                  </button>
                )}
                <button
                  className="button"
                  onClick={() =>
                    downloadText(
                      '笔迹检查点-' + (entry.draft.id ?? 'legacy') + '.json',
                      JSON.stringify(entry.draft, null, 2),
                    )
                  }
                >
                  导出原始检查点
                  <ArrowDownToLine size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ),
    });
  }
  function reviewBlock(blockId: string) {
    if (!canNavigate()) return;
    sectionOrigin.current = view;
    setReviewId(blockId);
    setReviewAll(true);
    setView('review');
    setSidebar(false);
  }
  const structure = note && (
    <Structure
      key={note.id}
      engine={e!}
      note={note}
      editable
      onChange={w.transact}
      onJump={jump}
      onProof={editable ? proof : () => setNotice('来源对应待平板校对')}
      activeBlockId={activeBlock}
      onReview={reviewBlock}
    />
  );
  if (!w.ready)
    return (
      <div className="loading">
        <div className="brand-mark">笺</div>
        <span>笺注</span>
      </div>
    );
  if (!e)
    return (
      <div className="empty hero">
        <ShieldCheck size={34} />
        <h1>资料库未能打开</h1>
        <p>{w.error}</p>
        <div className="button-row">
          <button
            className="button"
            onClick={async () => {
              downloadText(
                '笺注-原始资料库恢复.json',
                JSON.stringify(await readLocal('current'), null, 2),
              );
            }}
          >
            导出原始资料库
            <ArrowDownToLine size={16} />
          </button>
          <button className="button primary" onClick={() => location.reload()}>
            重新打开
            <RotateCcw size={16} />
          </button>
        </div>
      </div>
    );
  return (
    <div
      className={`app-shell ${window.QuietPaperNative ? 'platform-android' : ''}`}
      data-device-role={w.role}
      data-view={view}
    >
      <aside
        className={`sidebar ${sidebar ? 'open' : ''}`}
        id="app-sidebar"
        aria-label="主导航"
        ref={sidebarElement}
        inert={compactNavigation && !sidebar}
        role={compactNavigation ? 'dialog' : undefined}
        aria-modal={compactNavigation && sidebar ? true : undefined}
        aria-hidden={compactNavigation && !sidebar ? true : undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Tab' || !isDrawerTop()) return;
          const controls = Array.from(
            sidebarElement.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
              [],
          );
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="brand">
          <div className="brand-symbol" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="brand-wordmark">
            <strong>笺注</strong>
            <small>Glossa</small>
          </div>
        </div>
        {editable && (
          <button className="new-paper" onClick={() => newNote()}>
            <Plus size={18} />
            <span>一张新纸</span>
            <span className="shortcut">＋</span>
          </button>
        )}
        <nav aria-label="笔记与整理">
          <button
            className={
              (view === 'paper' || view === 'library') && !folderFilter
                ? 'nav-item active'
                : 'nav-item'
            }
            aria-current={
              (view === 'paper' || view === 'library') && !folderFilter ? 'page' : undefined
            }
            onClick={showLibrary}
          >
            <BookOpen size={18} />
            所有笔记<span>{e?.state.notes.length ?? 0}</span>
          </button>
          <button
            className={view === 'review' ? 'nav-item active' : 'nav-item'}
            aria-current={view === 'review' ? 'page' : undefined}
            onClick={() => navigateSection('review')}
          >
            <History size={18} />
            温故<span className={due.length ? 'count accent' : 'count'}>{due.length}</span>
          </button>
          <button
            className={view === 'proof' ? 'nav-item active' : 'nav-item'}
            aria-current={view === 'proof' ? 'page' : undefined}
            onClick={() => navigateSection('proof')}
          >
            <ScanLine size={18} />
            校对<span>{proofCount}</span>
          </button>
        </nav>
        <div className="sidebar-section">
          <span>文件夹</span>
          <IconButton title="新文件夹" onClick={newFolder}>
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="folder-list">
          {e?.state.folders.map((f, i) => (
            <button
              key={f.id}
              onClick={() => {
                if (!canNavigate()) return;
                setFolderFilter(f.id);
                setSearch('');
                setView('library');
                setSidebar(false);
              }}
              className={
                folderFilter === f.id && (view === 'paper' || view === 'library')
                  ? 'folder-item active'
                  : 'folder-item'
              }
              aria-current={
                folderFilter === f.id && (view === 'paper' || view === 'library')
                  ? 'page'
                  : undefined
              }
            >
              <span className={`folder-dot dot-${i % 3}`} />
              {f.name}
              <span>{e.state.notes.filter((n) => n.folderId === f.id).length}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-section recent-label">最近打开</div>
        <div className="recent-list">
          {!notes.length && <p className="recent-empty">打开的笔记，会留在这里。</p>}
          {e?.state.notes
            .slice()
            .sort((a, b) => b.modifiedAt - a.modifiedAt)
            .slice(0, 4)
            .map((n) => (
              <button
                key={n.id}
                className={
                  n.id === note?.id && view === 'paper' ? 'recent-note active' : 'recent-note'
                }
                onClick={() => openNote(n)}
              >
                <FileText size={15} />
                <span>{n.title}</span>
              </button>
            ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className="sync-indicator"
            onClick={settingsDialog}
            aria-label="Mac 同步设置"
            data-state={
              w.syncState === '同步完成'
                ? 'connected'
                : /离线|失败|错误|待解锁|待处理/.test(w.syncState)
                  ? 'error'
                  : 'offline'
            }
          >
            {w.syncConfig ? <Cloud size={18} /> : <CloudOff size={18} />}
            <span className="sync-copy">
              <strong>{w.syncState}</strong>
              <small>设置 Mac 同步</small>
            </span>
            <ChevronRight size={15} />
          </button>
          <div className="sidebar-tools">
            <button onClick={settingsDialog}>
              <Settings2 size={17} />
              <span>设置</span>
            </button>
            <button
              onClick={() => navigateSection('activity')}
              aria-current={view === 'activity' ? 'page' : undefined}
            >
              <GitBranch size={17} />
              <span>运行状态</span>
            </button>
            <button onClick={exportDialog} aria-label="导出与恢复">
              <ArrowDownToLine size={17} />
              <span>导出恢复</span>
            </button>
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebar(false)}
        />
      )}
      <main className="main" ref={mainElement}>
        <header className="topbar">
          <button
            className="icon-button"
            title="导航"
            aria-label="导航"
            aria-controls="app-sidebar"
            aria-expanded={sidebar}
            onClick={() => {
              if (writing.current) {
                setNotice('请先抬笔，当前笔迹会保留');
                return;
              }
              setSidebar(!sidebar);
            }}
          >
            <Menu size={18} />
          </button>
          <div className="breadcrumb" aria-label="当前位置">
            {view === 'paper' && note ? (
              <IconButton title="返回笔记列表" onClick={returnToLibrary}>
                <ArrowLeft size={18} />
              </IconButton>
            ) : (
              <ViewIcon size={15} />
            )}
            {view === 'paper' && note ? (
              <>
                <button className="breadcrumb-link" onClick={showLibrary}>
                  所有笔记
                </button>
                {folderName && (
                  <span className="breadcrumb-folder">
                    <ChevronRight size={13} />
                    <button
                      className="breadcrumb-link"
                      onClick={() => {
                        setFolderFilter(note.folderId!);
                        setView('library');
                      }}
                    >
                      {folderName}
                    </button>
                  </span>
                )}
                <ChevronRight size={13} />
                <span title={note.title}>{note.title}</span>
              </>
            ) : (
              <>
                <span>{viewTitle}</span>
                {view === 'library' && folderName && (
                  <>
                    <ChevronRight size={13} />
                    <span>{folderName}</span>
                  </>
                )}
              </>
            )}
          </div>
          <div className="topbar-right">
            {showSaveStatus && (
              <span
                className={`save-status ${w.saveState === '保存失败' ? 'bad' : ''}`}
                role="status"
                data-state={
                  w.saveState === '已存于本机'
                    ? 'saved'
                    : w.saveState.includes('失败')
                      ? 'error'
                      : 'pending'
                }
              >
                <span />
                {w.saveState}
              </span>
            )}
            <span className="device-label">
              {window.QuietPaperNative
                ? w.role === 'tablet'
                  ? 'ANDROID 平板'
                  : 'ANDROID 手机'
                : import.meta.env.DEV
                  ? `开发${w.role === 'tablet' ? '平板' : w.role === 'phone' ? '手机' : 'MAC'}工作台`
                  : 'MAC 阅读端'}
            </span>
            <IconButton
              title="搜索笔记"
              onClick={() => {
                if (!canNavigate()) return;
                setView('library');
                setSidebar(false);
                requestAnimationFrame(() => searchInput.current?.focus());
              }}
            >
              <Search size={18} />
            </IconButton>
          </div>
        </header>
        {w.error && (
          <div className="error-banner" role="alert">
            <ShieldCheck size={18} />
            <span>{w.error}</span>
            <button aria-label="关闭错误" onClick={() => w.setError('')}>
              <X size={17} />
            </button>
          </div>
        )}
        {w.pendingDrafts.length > 0 && (
          <button className="draft-recovery-banner" onClick={draftRecovery}>
            <History size={17} />
            <span>{w.pendingDrafts.length} 份原始笔迹检查点待恢复</span>
            <ArrowRight size={16} />
          </button>
        )}
        {view === 'paper' && note && page ? (
          <>
            <div className="note-heading">
              <div>
                <div className="eyebrow">A PLACE FOR YOUR THOUGHTS</div>
                <h1 onDoubleClick={manage}>{note.title}</h1>
                <div className="note-meta">
                  <span>{date(note.modifiedAt)}</span>
                  <span className="meta-divider" />
                  {note.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                  <button className="text-button" onClick={manage}>
                    归档
                    <ChevronDown size={13} />
                  </button>
                </div>
              </div>
              <div className="heading-actions">
                {editable && (
                  <IconButton title="知识块与关联" onClick={() => setShowBlocks(true)}>
                    <GitBranch size={20} />
                  </IconButton>
                )}
                <IconButton title="修订与历史" onClick={revisions}>
                  <History size={20} />
                </IconButton>
                <IconButton title="笔记管理" onClick={manage}>
                  <MoreHorizontal size={22} />
                </IconButton>
              </div>
            </div>
            <div className="workspace-bar">
              <div className="representation-switch" role="group" aria-label="阅读方式">
                <button
                  className={mode === 'a' ? 'active' : ''}
                  aria-pressed={mode === 'a'}
                  onClick={() => setMode('a')}
                >
                  原稿 <span>A</span>
                </button>
                <button
                  className={mode === 'b' ? 'active' : ''}
                  aria-pressed={mode === 'b'}
                  onClick={() => setMode('b')}
                >
                  结构 <span>B</span>
                </button>
                <button
                  className={mode === 'split' ? 'active' : ''}
                  aria-pressed={mode === 'split'}
                  onClick={() => setMode('split')}
                >
                  <ArrowLeftRight size={14} />
                  对照
                </button>
              </div>
              <div className="paper-spec">
                <span>{page.size}</span>
                <span>{page.orientation === 'portrait' ? '纵向' : '横向'}</span>
                <IconButton
                  title="图层"
                  onClick={() =>
                    setModal({
                      title: '图层',
                      content: (
                        <div className="dialog-stack">
                          {[
                            ...new Set([
                              'ink',
                              'notes',
                              ...page.objects
                                .filter((o) => !o.deleted)
                                .map((o) => o.layerId)
                                .filter((id) => !id.startsWith('revision:')),
                            ]),
                          ].map((id) => (
                            <button
                              className={`layer-row ${id === layer ? 'active' : ''}`}
                              key={id}
                              onClick={() => {
                                setLayer(id);
                                setModal(null);
                              }}
                            >
                              <Layers size={16} />
                              {id === 'ink' ? '原始笔迹' : id === 'notes' ? '补充笔记' : id}
                              {id === layer && <Check size={15} />}
                            </button>
                          ))}
                          <button className="button" onClick={revisions}>
                            独立修订层
                            <History size={15} />
                          </button>
                        </div>
                      ),
                    })
                  }
                >
                  <Layers size={16} />
                </IconButton>
                {editable && (
                  <IconButton title="添加纸张" onClick={paperDialog}>
                    <Plus size={18} />
                  </IconButton>
                )}
              </div>
            </div>
            <div className={`workspace workspace-${mode}`}>
              {mode !== 'b' && (
                <section className="paper-region">
                  <div className="paper-overline">
                    <span>原稿 / ORIGINAL</span>
                    <span>
                      {String(pageIndex + 1).padStart(2, '0')} —{' '}
                      {String(note.pages.length).padStart(2, '0')}
                    </span>
                  </div>
                  <div className="paper-frame">
                    <Paper
                      note={note}
                      page={page}
                      tool={tool}
                      color={color}
                      width={penWidth}
                      layer={layer}
                      editable={editable}
                      selected={selected}
                      highlighted={highlighted}
                      onSelect={setSelected}
                      onStroke={(points) => {
                        writing.current = false;
                        w.stroke(note.id, page.id, points, {
                          color,
                          width: penWidth,
                          layerId: layer,
                        });
                      }}
                      onDraft={(points) => {
                        writing.current = !!points;
                        w.checkpoint(
                          points
                            ? {
                                noteId: note.id,
                                pageId: page.id,
                                points,
                                color,
                                width: penWidth,
                                layerId: layer,
                              }
                            : null,
                        );
                      }}
                      onErase={erase}
                      onMove={moveObjects}
                      onInsert={addText}
                      onContext={counterpart}
                    />
                  </div>
                  <div className="page-nav" role="group" aria-label="纸张导航">
                    <button
                      disabled={pageIndex === 0}
                      aria-label="上一页"
                      onClick={() => {
                        setPageIndex((i) => i - 1);
                        setSelected([]);
                      }}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    {note.pages.map((p, i) => (
                      <button
                        className={i === pageIndex ? 'active' : ''}
                        aria-current={i === pageIndex ? 'page' : undefined}
                        aria-label={`第 ${i + 1} 页`}
                        key={p.id}
                        onClick={() => {
                          setPageIndex(i);
                          setSelected([]);
                        }}
                      >
                        {String(i + 1).padStart(2, '0')}
                      </button>
                    ))}
                    <button
                      disabled={pageIndex >= note.pages.length - 1}
                      aria-label="下一页"
                      onClick={() => {
                        setPageIndex((i) => i + 1);
                        setSelected([]);
                      }}
                    >
                      <ChevronRight size={16} />
                    </button>
                    {editable && (
                      <button onClick={paperDialog} aria-label="新纸张">
                        <Plus size={16} />
                      </button>
                    )}
                  </div>
                </section>
              )}
              {mode !== 'a' && (
                <aside className="structure-region">
                  <div className="structure-heading">
                    <span>结构 / STRUCTURED</span>
                    <span>{String(note.blocks.length).padStart(2, '0')}</span>
                  </div>
                  {structure}
                </aside>
              )}
            </div>
            {editable && mode !== 'b' && (
              <div className="writing-dock">
                <div className="dock-tools">
                  {(
                    [
                      { key: 'pen', label: '钢笔', icon: PenLine },
                      { key: 'eraser', label: '局部橡皮', icon: Eraser },
                      { key: 'select', label: '框选与移动', icon: SquareDashedMousePointer },
                      { key: 'text', label: '文字', icon: Type },
                      { key: 'formula', label: '公式', icon: FunctionIcon },
                    ] as const
                  ).map((t) => (
                    <IconButton
                      key={t.key}
                      title={t.label}
                      active={tool === t.key}
                      onClick={() => {
                        setTool(t.key);
                        if (t.key !== 'select') setSelected([]);
                      }}
                    >
                      <t.icon size={19} />
                    </IconButton>
                  ))}
                </div>
                <span className="dock-divider" />
                <div className="ink-colors">
                  {['#3f3b42', '#67755d', '#926c59'].map((c) => (
                    <button
                      key={c}
                      style={{ background: c }}
                      aria-label={`墨色 ${c}`}
                      className={color === c ? 'active' : ''}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
                <button
                  className="pen-width"
                  title="笔宽"
                  onClick={() => setPenWidth((v) => (v === 2.4 ? 4.5 : v === 4.5 ? 1.2 : 2.4))}
                >
                  <span style={{ height: Math.max(2, penWidth) }} />
                </button>
                <span className="dock-divider" />
                <IconButton title="插入图片" onClick={() => imageInput.current?.click()}>
                  <ImagePlus size={19} />
                </IconButton>
                <IconButton title="导入原生文件" onClick={openSource}>
                  <FileInput size={19} />
                </IconButton>
                {selected.length > 0 && (
                  <>
                    <span className="dock-divider" />
                    <IconButton title="建立知识块" onClick={createBlock}>
                      <GitBranch size={19} />
                    </IconButton>
                    <IconButton title="拉直线条" onClick={tidySelected}>
                      <Highlighter size={18} />
                    </IconButton>
                    <IconButton title="校对选中内容" onClick={() => proof(selected)}>
                      <ScanLine size={19} />
                    </IconButton>
                    <IconButton title="学习选中字形" onClick={learnHandwriting}>
                      <PenLine size={19} />
                    </IconButton>
                    <IconButton title="删除选中内容" onClick={deleteSelected}>
                      <Trash2 size={18} />
                    </IconButton>
                  </>
                )}
              </div>
            )}
          </>
        ) : view === 'paper' ? (
          <div className={`empty hero ${editable ? 'kind-create' : 'kind-reader'}`}>
            <div className="empty-paper" aria-hidden="true" />
            <h1>{editable ? '从一张纸开始' : '把笔记带在身边'}</h1>
            <p className="empty-copy">
              {editable
                ? '落笔即可记录，整理与温故留待稍后。'
                : '导入已有笔记，阅读原稿，也让文字与公式继续生长。'}
            </p>
            <div className="empty-actions">{entryAction()}</div>
            {!editable && <p className="empty-note">新笔记，从 Android 平板开始。</p>}
          </div>
        ) : null}
        {view === 'library' && (
          <div className="content-page library">
            <div className="section-heading">
              <div>
                <div className="eyebrow">THE THINGS WE KEEP</div>
                <h1>
                  {folderFilter
                    ? e?.state.folders.find((f) => f.id === folderFilter)?.name
                    : '所有笔记'}
                </h1>
              </div>
              <div className="library-search">
                <Search size={17} />
                <input
                  ref={searchInput}
                  className="search-input"
                  aria-label="搜索文字、公式与标签"
                  placeholder="搜索文字、公式与标签"
                  value={search}
                  onChange={(ev) => setSearch(ev.target.value)}
                />
              </div>
            </div>
            <div className="note-grid">
              {visibleNotes.map((n) => (
                <button className="note-card" key={n.id} onClick={() => openNote(n)}>
                  <div className="note-card-preview">
                    <PaperPreview page={n.pages[0]} />
                    <span>{n.pages.length} 页</span>
                  </div>
                  <div className="note-card-body">
                    <span className="eyebrow">
                      {e.state.folders.find((f) => f.id === n.folderId)?.name ?? '未归档'}
                    </span>
                    <h2>{n.title}</h2>
                    <div>
                      <span>{date(n.modifiedAt)}</span>
                      <ArrowRight size={16} />
                    </div>
                  </div>
                </button>
              ))}
              {editable && visibleNotes.length > 0 && (
                <button className="note-card new-note-card" onClick={() => newNote()}>
                  <Plus size={30} />
                  <span>一张新纸</span>
                </button>
              )}
            </div>
            {!visibleNotes.length && (
              <div className="empty library-empty">
                {notes.length ? (
                  <Search size={34} />
                ) : (
                  <div className="empty-paper" aria-hidden="true" />
                )}
                <h2>
                  {search
                    ? '还没有找到这段记忆'
                    : folderFilter
                      ? '这个文件夹，留给下一篇笔记'
                      : editable
                        ? '记下第一笔'
                        : '让已有笔记，回到眼前'}
                </h2>
                <p className="empty-copy">
                  {notes.length
                    ? '试试其他文字、公式或标签，也可以回看全部笔记。'
                    : editable
                      ? '无需先建知识块，打开一张纸就能开始。'
                      : '导入笔记后，即可阅读原稿、修订已有内容与温故。'}
                </p>
                <div className="empty-actions">
                  {notes.length ? (
                    <button className="button" onClick={showLibrary}>
                      查看所有笔记
                      <ArrowRight size={16} />
                    </button>
                  ) : (
                    entryAction()
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        {view === 'review' && (
          <div className="content-page review-page">
            <div className="section-heading">
              <div>
                <div className="eyebrow">REVISIT &amp; REMEMBER</div>
                <h1>温故</h1>
              </div>
              <div className="section-meta">
                <span className="count-badge">{due.length} 今日待复习</span>
                <button
                  className="button"
                  onClick={() =>
                    setModal({
                      title: '复习偏好',
                      content: (
                        <FormModal
                          onSubmit={(data) => {
                            w.transact((engine) =>
                              engine.setSetting('reviewSettings', {
                                algorithm: String(data.get('algorithm')),
                                dailyLimit: Number(data.get('limit')),
                                intensity: Number(data.get('intensity')),
                                fixedDays: Number(data.get('days')),
                                examAt: String(data.get('exam'))
                                  ? new Date(String(data.get('exam'))).getTime()
                                  : undefined,
                              }),
                            );
                            setModal(null);
                          }}
                        >
                          <label>
                            间隔算法
                            <select name="algorithm" defaultValue={reviewSettings.algorithm}>
                              <option value="adaptive">自适应间隔</option>
                              <option value="fixed">固定间隔</option>
                            </select>
                          </label>
                          <div className="form-grid">
                            <label>
                              每日知识块
                              <input
                                name="limit"
                                type="number"
                                min="0"
                                max="1000"
                                defaultValue={reviewSettings.dailyLimit ?? 20}
                              />
                            </label>
                            <label>
                              固定间隔 / 天
                              <input
                                name="days"
                                type="number"
                                min="1"
                                defaultValue={reviewSettings.fixedDays ?? 3}
                              />
                            </label>
                          </div>
                          <label>
                            强度
                            <select name="intensity" defaultValue={reviewSettings.intensity ?? 1}>
                              <option value="0.5">舒缓</option>
                              <option value="1">日常</option>
                              <option value="2">加强</option>
                            </select>
                          </label>
                          <label>
                            考试目标
                            <input
                              name="exam"
                              type="date"
                              defaultValue={
                                reviewSettings.examAt
                                  ? new Date(reviewSettings.examAt).toISOString().slice(0, 10)
                                  : ''
                              }
                            />
                          </label>
                        </FormModal>
                      ),
                    })
                  }
                >
                  <CalendarDays size={16} />
                  排期
                </button>
              </div>
            </div>
            <div className="review-tabs">
              <button
                className={!reviewAll ? 'active' : ''}
                aria-pressed={!reviewAll}
                onClick={() => {
                  setReviewAll(false);
                  setReviewId('');
                }}
              >
                今日待复习 <b>{due.length}</b>
              </button>
              <button
                className={reviewAll ? 'active' : ''}
                aria-pressed={reviewAll}
                onClick={() => setReviewAll(true)}
              >
                全部复习内容 <b>{cards.length}</b>
              </button>
            </div>
            {(() => {
              const list = reviewAll ? cards : due;
              const card = list.find((c) => c.blockId === reviewId) ?? list[0];
              const n = e?.state.notes.find((n) => n.id === card?.noteId);
              const block = n?.blocks.find((b) => b.id === card?.blockId);
              return (
                <div className="review-layout">
                  {list.length > 0 && (
                    <aside className="review-list">
                      {list.map((c) => (
                        <button
                          key={c.blockId}
                          className={c.blockId === card?.blockId ? 'active' : ''}
                          aria-current={c.blockId === card?.blockId ? 'true' : undefined}
                          onClick={() => setReviewId(c.blockId)}
                        >
                          <span>
                            {
                              e?.state.notes
                                .flatMap((n) => n.blocks)
                                .find((b) => b.id === c.blockId)?.title
                            }
                          </span>
                          <span>
                            {date(c.dueAt)} · {c.reviews} 次
                          </span>
                        </button>
                      ))}
                    </aside>
                  )}
                  {card && n && block ? (
                    <section className="review-sheet">
                      <div className="review-sheet-top">
                        <span className="eyebrow">{n.title}</span>
                        <div
                          className="representation-switch small"
                          role="group"
                          aria-label="复习阅读方式"
                        >
                          <button
                            className={reviewMode === 'a' ? 'active' : ''}
                            aria-pressed={reviewMode === 'a'}
                            onClick={() => setReviewMode('a')}
                          >
                            A
                          </button>
                          <button
                            className={reviewMode === 'b' ? 'active' : ''}
                            aria-pressed={reviewMode === 'b'}
                            onClick={() => setReviewMode('b')}
                          >
                            B
                          </button>
                          <button
                            className={reviewMode === 'split' ? 'active' : ''}
                            aria-pressed={reviewMode === 'split'}
                            onClick={() => setReviewMode('split')}
                          >
                            A / B
                          </button>
                        </div>
                      </div>
                      <h2>{block.title}</h2>
                      <div className={`review-content ${reviewMode === 'split' ? 'split' : ''}`}>
                        {reviewMode !== 'b' && (
                          <div>
                            {n.pages
                              .filter((p) =>
                                p.objects.some((o) =>
                                  effectiveBlockObjects(e!, n, block.id).includes(o.id),
                                ),
                              )
                              .map((p) => (
                                <PaperPreview
                                  key={p.id}
                                  page={p}
                                  objectIds={effectiveBlockObjects(e!, n, block.id)}
                                />
                              ))}
                          </div>
                        )}
                        {reviewMode !== 'a' && (
                          <div className="review-b">
                            {block.segments
                              .filter((s) => !s.deleted)
                              .map((s) => (
                                <div key={s.id} className={s.kind === 'formula' ? 'math' : ''}>
                                  {s.kind === 'reference'
                                    ? n.pages
                                        .filter((p) =>
                                          p.objects.some((o) =>
                                            e!
                                              .findCorrespondence(n.id, s.id)
                                              .objectIds.includes(o.id),
                                          ),
                                        )
                                        .map((p) => (
                                          <PaperPreview
                                            key={p.id}
                                            page={p}
                                            objectIds={e!.findCorrespondence(n.id, s.id).objectIds}
                                          />
                                        ))
                                    : s.text}
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                      <div className="self-rating">
                        <button
                          className="button"
                          onClick={() => {
                            w.transact((engine) => {
                              const next = scheduleReview(card, false, reviewSettings);
                              engine.setSetting('review:' + card.blockId, next);
                              engine.setSetting('review-event:' + crypto.randomUUID(), {
                                ...next.history.at(-1),
                                blockId: card.blockId,
                                noteId: card.noteId,
                                settings: reviewSettings,
                                outcome: { stability: next.stability, difficulty: next.difficulty },
                              });
                            });
                            setReviewId(
                              list.find((c) => c.blockId !== card.blockId)?.blockId ?? '',
                            );
                            setNotice('已调整下次复习');
                          }}
                        >
                          未掌握
                          <RotateCcw size={17} />
                        </button>
                        <button
                          className="button primary"
                          onClick={() => {
                            w.transact((engine) => {
                              const next = scheduleReview(card, true, reviewSettings);
                              engine.setSetting('review:' + card.blockId, next);
                              engine.setSetting('review-event:' + crypto.randomUUID(), {
                                ...next.history.at(-1),
                                blockId: card.blockId,
                                noteId: card.noteId,
                                settings: reviewSettings,
                                outcome: { stability: next.stability, difficulty: next.difficulty },
                              });
                            });
                            setReviewId(
                              list.find((c) => c.blockId !== card.blockId)?.blockId ?? '',
                            );
                            setNotice('已记住，留待下一次相见');
                          }}
                        >
                          已掌握
                          <Check size={17} />
                        </button>
                      </div>
                    </section>
                  ) : (
                    <div className="empty review-empty">
                      {cards.length ? <CircleCheck size={36} /> : <BookOpen size={36} />}
                      <h2>
                        {cards.length
                          ? '今日暂无待复习'
                          : notes.length
                            ? '还没有复习内容'
                            : '温故，从记录开始'}
                      </h2>
                      <p className="empty-copy">
                        {cards.length
                          ? '知识块仍在这里，想回顾时，随时翻开。'
                          : notes.length
                            ? '整理后的知识块会在这里排期，先回到笔记看看。'
                            : editable
                              ? '先留下一张纸，整理后的知识会在这里等待下一次相见。'
                              : '导入已有笔记后，在这里回看知识、安排复习。'}
                      </p>
                      <div className="empty-actions">
                        {cards.length ? (
                          <button className="text-button" onClick={() => setReviewAll(true)}>
                            查看全部复习内容
                            <ArrowRight size={15} />
                          </button>
                        ) : (
                          entryAction()
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
        {view === 'proof' && (
          <div className="content-page proof-page">
            <div className="section-heading">
              <div>
                <div className="eyebrow">TRUE TO THE SOURCE</div>
                <h1>校对</h1>
              </div>
              <div className="section-meta">
                <span className="count-badge">{proofCount} 待校对</span>
              </div>
            </div>
            {conflicts.map((c) => (
              <div className="conflict-card" key={c.id}>
                <div className="eyebrow">
                  {c.kind === 'character'
                    ? '字符冲突'
                    : c.kind === 'object'
                      ? '对象冲突'
                      : c.kind === 'structure'
                        ? '知识块归属冲突'
                        : '操作依赖冲突'}
                </div>
                <div className="conflict-sides">
                  <div>
                    <span>已保留</span>
                    <ConflictVisual engine={e!} conflict={c} />
                    <button
                      className="button"
                      disabled={!editable && (c.kind === 'object' || c.kind === 'structure')}
                      onClick={() =>
                        w.transact((engine) => engine.resolveConflict(c.id, 'current'))
                      }
                    >
                      保留此内容
                      <Check size={15} />
                    </button>
                  </div>
                  <div>
                    <span>同步变更</span>
                    <ConflictVisual engine={e!} conflict={c} incoming />
                    <button
                      className="button"
                      disabled={!editable && (c.kind === 'object' || c.kind === 'structure')}
                      onClick={() =>
                        w.transact((engine) => engine.resolveConflict(c.id, 'incoming'))
                      }
                    >
                      采用此变更
                      <Check size={15} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {unmapped.map((item) => (
              <button
                className="proof-card"
                key={item.segment.id}
                onClick={() => proof(item.segment.source.objectIds, item.segment.id, item.note.id)}
              >
                <ScanLine size={21} />
                <div>
                  <h3>{item.block.title}</h3>
                  <p>{item.segment.source.reason ?? '来源对应尚未确认'}</p>
                </div>
                <ArrowRight size={18} />
              </button>
            ))}
            {candidates.map((c) => {
              const n = e?.state.notes.find((n) => n.id === c.noteId);
              const p = n?.pages.find((p) => p.objects.some((o) => o.id === c.objectId));
              return (
                <button
                  className="proof-card"
                  key={c.key}
                  onClick={() => proof(c.sourceObjectIds ?? [c.objectId], undefined, c.noteId)}
                >
                  {p && <PaperPreview page={p} objectIds={c.sourceObjectIds ?? [c.objectId]} />}
                  <div>
                    <h3>{n?.title}</h3>
                    <p>{c.reason ?? '识别来源待核对'}</p>
                    {c.text && <span>{c.text}</span>}
                  </div>
                  <ArrowRight size={18} />
                </button>
              );
            })}
            {!proofCount && (
              <div className="empty proof-empty">
                <ShieldCheck size={36} />
                <h2>{notes.length ? '目前没有待校对内容' : '原稿先留下，校对慢慢来'}</h2>
                <p className="empty-copy">
                  识别结果或来源对应存疑时，会保留原稿，在这里标明原因，由你核对后确认。
                </p>
                <div className="empty-actions">{entryAction()}</div>
              </div>
            )}
          </div>
        )}
        {view === 'activity' && (
          <div className="content-page activity-page">
            <div className="section-heading">
              <div>
                <div className="eyebrow">BEHIND THE PAPER</div>
                <h1>运行状态</h1>
              </div>
              <div className="activity-actions">
                {window.QuietPaperNative?.getRuntimeDiagnostics && (
                  <button className="button" onClick={() => void runtimeDiagnosticsDialog()}>
                    窗口记录
                    <History size={16} />
                  </button>
                )}
                <button className="button" onClick={() => void w.flush()}>
                  立即整理
                  <Sparkles size={16} />
                </button>
              </div>
            </div>
            <div className="status-grid">
              {PIPELINE_STAGES.map((stage) => (
                <div className="status-card" key={stage}>
                  <div>
                    <span>{STAGES[stage]}</span>
                    <span className={`state-dot ${w.statuses?.[stage].state}`} />
                  </div>
                  <h3>{STATUS[w.statuses?.[stage].state ?? 'idle']}</h3>
                  <span>
                    {w.statuses?.[stage].processed ?? 0} 已处理 · {w.statuses?.[stage].pending ?? 0}{' '}
                    待处理
                  </span>
                  {w.statuses?.[stage].error && <p>{w.statuses[stage].error}</p>}
                </div>
              ))}
            </div>
            <div className="activity-sections">
              <section>
                <h2>同步与备份</h2>
                <div className="activity-row">
                  <Cloud size={18} />
                  <span>{w.syncState}</span>
                  <button className="text-button" onClick={() => void w.syncNow()}>
                    同步一次
                    <ArrowRight size={14} />
                  </button>
                </div>
                {w.syncError && <p className="inline-error">{w.syncError}</p>}
                <div className="activity-row">
                  <ShieldCheck size={18} />
                  <span>{w.saveState}</span>
                  <span>{w.persistent ? '持久存储已授予' : '系统管理存储'}</span>
                </div>
                <div className="activity-row">
                  <History size={18} />
                  <span>{e?.project.operations.length ?? 0} 条操作记录</span>
                  <button className="text-button" onClick={exportDialog}>
                    导出 / 恢复
                    <ArrowRight size={14} />
                  </button>
                </div>
              </section>
              <section>
                <h2>外部源文件</h2>
                {sources.length === 0 ? (
                  <div className="empty compact">
                    <FileText size={25} />
                    <span>没有关联源文件</span>
                  </div>
                ) : (
                  sources.map((s) => (
                    <div className="source-status" key={s.link.id}>
                      <div>
                        <h3>{s.document.name}</h3>
                        <span>
                          {s.link.mode === 'frozen'
                            ? '已冻结为独立副本'
                            : s.pendingNative
                              ? '原生待写回冲突'
                              : s.pendingSource
                                ? '待重新定位'
                                : s.link.status === 'clean'
                                  ? '已保存源快照'
                                  : s.link.status === 'conflict'
                                    ? '待确认源冲突'
                                    : s.link.status === 'unavailable'
                                      ? '源文件不可访问'
                                      : '待写回'}{' '}
                          · {s.link.queued.length} 项
                        </span>
                      </div>
                      <div className="button-row">
                        {s.uri && (
                          <button className="text-button" onClick={() => void processSource(s)}>
                            检查源文件
                            <ArrowLeftRight size={14} />
                          </button>
                        )}
                        {editable && s.pendingNative && (
                          <button
                            className="text-button"
                            onClick={() => sourceNativeConflictDialog(s)}
                          >
                            预览原生待写回
                            <ArrowLeftRight size={14} />
                          </button>
                        )}
                        {editable && s.pendingSource && (
                          <button className="text-button" onClick={() => sourceIdentityDialog(s)}>
                            定位对应对象
                            <Link2 size={14} />
                          </button>
                        )}
                        {editable && s.link.conflict && (
                          <button className="text-button" onClick={() => sourceConflictDialog(s)}>
                            预览并解决
                            <ArrowLeftRight size={14} />
                          </button>
                        )}
                        {editable && window.QuietPaperNative && s.link.mode === 'linked' && (
                          <button className="text-button" onClick={() => void relocateSource(s)}>
                            重新选择源文件
                            <FileInput size={14} />
                          </button>
                        )}
                        <button
                          className="text-button"
                          onClick={() =>
                            downloadText(
                              s.document.name,
                              serializeNative(s.document),
                              s.document.format === 'markdown'
                                ? 'text/markdown'
                                : 'application/x-tex',
                            )
                          }
                        >
                          导出源快照
                          <ArrowDownToLine size={14} />
                        </button>
                      </div>
                      {s.link.writeError && <p className="inline-error">{s.link.writeError}</p>}
                      {s.link.conflict && (
                        <div className="conflict-sides">
                          <pre>{s.link.conflict.paper}</pre>
                          <pre>{s.link.conflict.source}</pre>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </section>
              <section>
                <h2>精确对应</h2>
                <div className="activity-row">
                  <Link2 size={18} />
                  <span>{e?.validateMappings().filter((m) => m.valid).length ?? 0} 已验证</span>
                  <span>{unmapped.length} 待校对</span>
                </div>
                <div className="activity-row">
                  <Layers size={18} />
                  <span>{e?.state.corrections.length ?? 0} 个独立修订层</span>
                  <button className="text-button" onClick={revisions}>
                    查看
                    <ArrowRight size={14} />
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".md,.markdown,.tex,.latex"
        onChange={async (ev) => {
          const file = ev.target.files?.[0];
          if (file) importSource(file.name, await file.text());
          ev.target.value = '';
        }}
      />
      <input
        hidden
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(ev) => {
          const file = ev.target.files?.[0];
          if (file) {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
              w.setError('当前图片导入覆盖 PNG、JPEG、WebP');
              return;
            }
            if (file.size > 10 * 1024 * 1024) {
              w.setError('图片超过当前 10 MB 导入上限');
              return;
            }
            const reader = new FileReader();
            reader.onload = () =>
              w.transact((engine) =>
                engine.addImage(note!.id, page!.id, String(reader.result), {
                  x: 75,
                  y: 180,
                  width: Math.min(600, page!.width - 150),
                  height: 400,
                }),
              );
            reader.readAsDataURL(file);
          }
          ev.target.value = '';
        }}
      />
      <input
        hidden
        ref={projectInput}
        type="file"
        accept=".glossa,.quietpaper,.json"
        onChange={async (ev) => {
          const file = ev.target.files?.[0];
          if (file) {
            try {
              const text = await file.text();
              NotebookEngine.importProject(text);
              setModal({
                title: '恢复此工程？',
                content: (
                  <div className="dialog-stack">
                    <p>当前工程会保留本地恢复副本，再打开 {file.name}。</p>
                    <button
                      className="button primary"
                      onClick={() => {
                        void w
                          .importProject(text)
                          .then(() => {
                            resetNavigation();
                            setModal(null);
                            setNotice('工程恢复完成');
                          })
                          .catch((err) => w.setError(String(err)));
                      }}
                    >
                      确认恢复
                      <FileInput size={16} />
                    </button>
                  </div>
                ),
              });
            } catch (err) {
              w.setError('工程包未通过校验：' + String(err));
            }
          }
          ev.target.value = '';
        }}
      />
      {showRecovery && (
        <RecoveryManager
          workspace={w}
          onClose={() => setShowRecovery(false)}
          onRestored={() => {
            setShowRecovery(false);
            resetNavigation();
            setNotice('工程已恢复');
          }}
        />
      )}
      {showBlocks && editable && note && e && (
        <BlockManager
          engine={e}
          note={note}
          onChange={w.transact}
          onClose={() => setShowBlocks(false)}
        />
      )}
      {modal && (
        <DialogShell
          key={modal.title}
          title={modal.title}
          wide={modal.wide}
          error={w.error}
          onClose={() => setModal(null)}
        >
          {modal.content}
        </DialogShell>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}
function pointsBounds(points: Point[]): Bounds {
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(1, Math.max(...points.map((p) => p.x)) - x),
    height: Math.max(1, Math.max(...points.map((p) => p.y)) - y),
  };
}
function FunctionIcon({ size = 20 }: { size?: number }) {
  return (
    <span
      style={{
        fontFamily: 'Georgia,serif',
        fontStyle: 'italic',
        fontSize: size + 3,
        lineHeight: 1,
      }}
    >
      ƒ
    </span>
  );
}
function SettingsPanel({
  workspace: w,
  onClose,
  onNotice,
}: {
  workspace: ReturnType<typeof useWorkspace>;
  onClose: () => void;
  onNotice: (s: string) => void;
}) {
  const [tab, setTab] = useState('writing');
  const [message, setMessage] = useState('');
  const e = w.engine!;
  return (
    <div className="settings-panel">
      <div className="settings-tabs">
        {[
          ['writing', '书写与整理'],
          ['recognition', '识别与仿手写'],
          ['sync', 'Mac 同步'],
          ['ai', '外部识别'],
        ].map(([id, label]) => (
          <button
            className={tab === id ? 'active' : ''}
            key={id}
            aria-pressed={tab === id}
            onClick={(event) => {
              if (tab === id) return;
              const dirty = event.currentTarget
                .closest('.settings-panel')
                ?.querySelector('form[data-dirty="true"]');
              if (dirty && !window.confirm('当前偏好尚未保存，放弃输入并切换？')) return;
              setTab(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {message && <div className="inline-error">{message}</div>}
      {tab === 'recognition' && <RecognitionSettings workspace={w} />}
      {tab === 'writing' && (
        <FormModal
          onSubmit={(data) => {
            const stages = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, data.has(s)]));
            const idleMs = Number(data.get('idle')) * 1000;
            w.transact((engine) => {
              engine.setSetting('idleMs', idleMs);
              engine.setSetting('stages', stages);
              engine.setSetting('sourceOfflineDays', Number(data.get('offline')));
            });
            w.configureProcessor({ idleMs, stages });
            onClose();
            onNotice('偏好已保存');
          }}
        >
          <label>
            停笔等待 / 秒
            <input
              type="number"
              name="idle"
              min="0.3"
              max="30"
              step="0.1"
              defaultValue={Number(e.state.settings.idleMs ?? 1400) / 1000}
            />
          </label>
          <div className="stage-switches">
            {PIPELINE_STAGES.map((s) => (
              <label key={s}>
                <span>{STAGES[s]}</span>
                <input
                  name={s}
                  type="checkbox"
                  defaultChecked={
                    (e.state.settings.stages as Record<string, boolean> | undefined)?.[s] !== false
                  }
                />
              </label>
            ))}
          </div>
          <label>
            源文件离线冻结 / 天
            <input
              name="offline"
              type="number"
              min="1"
              max="3650"
              defaultValue={Number(e.state.settings.sourceOfflineDays ?? 30)}
            />
          </label>
        </FormModal>
      )}
      {tab === 'sync' && (
        <>
          <FormModal
            button={w.syncConfig ? '更新连接' : '连接服务器'}
            onSubmit={async (data) => {
              try {
                await w.connect({
                  url: String(data.get('url')),
                  token: String(data.get('token')),
                  projectId: String(data.get('project')),
                  mode: String(data.get('mode')) as 'plain' | 'e2ee',
                  passphrase: String(data.get('passphrase')) || undefined,
                });
                setMessage('');
                onClose();
                onNotice('同步连接已启用');
              } catch (err) {
                setMessage(String(err));
              }
            }}
          >
            <label>
              Mac 服务器
              <input
                name="url"
                type="url"
                required
                placeholder="https://paper.example.com"
                defaultValue={w.syncConfig?.url ?? ''}
              />
            </label>
            <label>
              工程标识
              <input
                name="project"
                required
                defaultValue={w.syncConfig?.projectId ?? e.project.id}
                readOnly={e.state.notes.length > 0}
              />
            </label>
            <label>
              访问令牌
              <input
                name="token"
                type="password"
                required
                minLength={24}
                defaultValue={w.syncConfig?.token}
              />
            </label>
            <label>
              加密模式
              <select name="mode" defaultValue={w.syncConfig?.mode ?? 'plain'}>
                <option value="plain">普通同步</option>
                <option value="e2ee">端到端加密</option>
              </select>
            </label>
            <label>
              加密口令
              <input
                name="passphrase"
                type="password"
                minLength={12}
                autoComplete="off"
                defaultValue={w.syncConfig?.passphrase}
              />
            </label>
            <div className="status-line">
              <ShieldCheck size={16} />
              Mac AI 临时解密代理尚未开放
            </div>
          </FormModal>
          {w.syncConfig && (
            <button
              className="text-button disconnect"
              onClick={() => {
                void w.disconnect();
                onClose();
              }}
            >
              断开自动同步
              <CloudOff size={15} />
            </button>
          )}
        </>
      )}
      {tab === 'ai' && (
        <>
          <FormModal
            button="授权并启用"
            onSubmit={(data) => {
              const config = {
                endpoint: String(data.get('endpoint')),
                model: String(data.get('model')),
                apiKey: String(data.get('key')),
                consent: {
                  granted: true,
                  grantedAt: Date.now(),
                  scope: 'changed-objects' as const,
                },
              };
              w.setProvider(config);
              onClose();
              onNotice('已授权当前会话的变化对象识别');
            }}
          >
            <label>
              兼容 API 地址
              <input
                name="endpoint"
                type="url"
                required
                placeholder="https://api.example.com/v1"
                defaultValue={w.provider?.endpoint}
              />
            </label>
            <label>
              模型
              <input name="model" required defaultValue={w.provider?.model} />
            </label>
            <label>
              API 密钥
              <input name="key" type="password" required autoComplete="off" />
            </label>
            <label className="check-row">
              <input type="checkbox" required />
              允许将变化对象发送至此服务以转录与整理
            </label>
          </FormModal>
          {w.provider && (
            <button
              className="text-button disconnect"
              onClick={() => {
                w.setProvider(undefined);
                onClose();
                onNotice('外部识别授权已撤销');
              }}
            >
              撤销授权
              <X size={15} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
export default App;
