/** Native-text adapters. Every edit is applied to source spans; unrelated bytes are preserved. */
export type NativeFormat = 'markdown' | 'latex';
export type NativeObjectKind = 'heading' | 'text' | 'formula' | 'code' | 'source';
export interface NativeObject {
  id: string;
  kind: NativeObjectKind;
  start: number;
  end: number;
  text: string;
  fingerprint: string;
}
export interface NativeSnapshot {
  revision: number;
  name: string;
  text: string;
  objects: NativeObject[];
  at: number;
  reason: string;
}
export interface NativeDocument {
  schema: 1;
  id: string;
  name: string;
  format: NativeFormat;
  text: string;
  revision: number;
  fingerprint: string;
  objects: NativeObject[];
  history: NativeSnapshot[];
}
export interface NativeEdit {
  objectId: string;
  replacement: string;
}
export interface TextChange {
  start: number;
  end: number;
  text: string;
}
export interface NativeConflict {
  base: string;
  paper: string;
  source: string;
  paperChanges: TextChange[];
  sourceChanges: TextChange[];
  reason: string;
  kind?: 'contention' | 'unverified-correspondence';
}
export interface NativeLink {
  schema: 1;
  id: string;
  sourceId: string;
  objectId: string;
  sourceName: string;
  sourceFingerprint: string;
  sourceRevision: number;
  baseContent: string;
  paperContent: string;
  sourceSnapshot: NativeDocument;
  mode: 'linked' | 'frozen' | 'detached';
  status: 'clean' | 'pending' | 'conflict' | 'unavailable' | 'missing' | 'frozen' | 'detached';
  offlineTimeoutMs: number;
  unavailableSince?: number;
  lastSourceContact: number;
  queued: { id: string; kind: 'edit' | 'delete-source'; text: string; at: number }[];
  conflict?: NativeConflict;
  frozenAt?: number;
  deleted?: boolean;
  writeError?: string;
}
export interface LinkResult {
  link: NativeLink;
  document: NativeDocument;
  conflict?: NativeConflict;
  writeError?: string;
}

const uid = () => globalThis.crypto.randomUUID();
const clone = <T>(value: T): T => structuredClone(value);
/** A lookup hint only. Identity/relink verification also compares exact source text. */
export function sourceFingerprint(text: string): string {
  let hash = 14695981039346656037n;
  for (const ch of text) {
    hash ^= BigInt(ch.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `fnv64:${hash.toString(16).padStart(16, '0')}:${text.length}`;
}

function nativeFormat(name: string): NativeFormat {
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.(tex|latex)$/i.test(name)) return 'latex';
  throw new Error('当前原生编辑覆盖 .md / .markdown / .tex / .latex；其他格式尚未验证。');
}

/** Source regions are not a claim that every Markdown/TeX dialect has been semantically parsed. */
function parseRegions(text: string, format: NativeFormat): NativeObject[] {
  const regions: NativeObject[] = [];
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter((m) => m[0].length > 0);
  let index = 0;
  while (index < lines.length) {
    const first = lines[index];
    const start = first.index!;
    let end = start + first[0].length;
    let kind: NativeObjectKind = 'text';
    const trimmed = first[0].trim();
    if (format === 'markdown' && /^(#{1,6})\s/.test(trimmed)) kind = 'heading';
    else if (format === 'markdown' && /^(```|~~~)/.test(trimmed)) {
      kind = 'code';
      const marker = trimmed.slice(0, 3);
      while (++index < lines.length) {
        end = lines[index].index! + lines[index][0].length;
        if (lines[index][0].trim().startsWith(marker)) break;
      }
    } else if (/^\$\$/.test(trimmed)) {
      kind = 'formula';
      if (!(trimmed.length > 2 && trimmed.endsWith('$$'))) {
        while (++index < lines.length) {
          end = lines[index].index! + lines[index][0].length;
          if (lines[index][0].trim().endsWith('$$')) break;
        }
      }
    } else if (format === 'latex') {
      kind = /^\\(section|subsection|chapter|title)\b/.test(trimmed) ? 'heading' : 'source';
      const env = trimmed.match(/^\\begin\{(equation\*?|align\*?|gather\*?|displaymath)\}/)?.[1];
      if (env) {
        kind = 'formula';
        if (!trimmed.includes(`\\end{${env}}`))
          while (++index < lines.length) {
            end = lines[index].index! + lines[index][0].length;
            if (lines[index][0].includes(`\\end{${env}}`)) break;
          }
      }
    }
    const content = text.slice(start, end);
    // Blank source lines remain in the document, but do not need paper objects.
    if (content.trim())
      regions.push({
        id: uid(),
        kind,
        start,
        end,
        text: content,
        fingerprint: sourceFingerprint(content),
      });
    index++;
  }
  return regions;
}

export function openNative(name: string, text: string, id: string = uid()): NativeDocument {
  const format = nativeFormat(name);
  return {
    schema: 1,
    id,
    name,
    format,
    text,
    revision: 0,
    fingerprint: sourceFingerprint(text),
    objects: parseRegions(text, format),
    history: [],
  };
}
/** UTF-8 input only. BOM and line endings survive byte-for-byte when regions are not changed. */
export function openNativeBytes(
  name: string,
  bytes: Uint8Array,
  id: string = uid(),
): NativeDocument {
  return openNative(
    name,
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    id,
  );
}
export function serializeNative(document: NativeDocument): string {
  validateNative(document);
  return document.text;
}
export function serializeNativeBytes(document: NativeDocument): Uint8Array {
  return new TextEncoder().encode(serializeNative(document));
}
export function validateNative(document: NativeDocument): void {
  if (
    document.schema !== 1 ||
    !['markdown', 'latex'].includes(document.format) ||
    !Array.isArray(document.objects) ||
    typeof document.text !== 'string'
  )
    throw new Error('无效原生文档');
  const ids = new Set<string>();
  let end = 0;
  const boundary = (at: number) =>
    !(
      at > 0 &&
      at < document.text.length &&
      /[\uD800-\uDBFF]/.test(document.text[at - 1]) &&
      /[\uDC00-\uDFFF]/.test(document.text[at])
    );
  for (const object of [...document.objects].sort((a, b) => a.start - b.start)) {
    if (
      typeof object.id !== 'string' ||
      !object.id ||
      ids.has(object.id) ||
      !Number.isInteger(object.start) ||
      !Number.isInteger(object.end) ||
      object.start < end ||
      object.end < object.start ||
      object.end > document.text.length ||
      !boundary(object.start) ||
      !boundary(object.end) ||
      document.text.slice(object.start, object.end) !== object.text ||
      sourceFingerprint(object.text) !== object.fingerprint
    )
      throw new Error('原生对象与源区间不一致');
    ids.add(object.id);
    end = object.end;
  }
  if (sourceFingerprint(document.text) !== document.fingerprint)
    throw new Error('源文件指纹不一致');
}

/** Replacements preserve source outside the explicitly selected objects, including CRLF/comments. */
export function editNative(
  document: NativeDocument,
  edits: NativeEdit[],
  now = Date.now(),
): NativeDocument {
  validateNative(document);
  const replacements = new Map<string, string>();
  for (const edit of edits) {
    if (!document.objects.some((o) => o.id === edit.objectId))
      throw new Error('原生对象不存在；须重新定位，不能猜测对应关系');
    if (replacements.has(edit.objectId)) throw new Error('同一事务不能重复修改同一对象');
    replacements.set(edit.objectId, edit.replacement);
  }
  if (
    ![...replacements].some(
      ([id, text]) => document.objects.find((o) => o.id === id)!.text !== text,
    )
  )
    return clone(document);
  const next = clone(document);
  next.objects.sort((a, b) => a.start - b.start);
  let offset = 0;
  const parts: string[] = [];
  let consumed = 0;
  for (const object of next.objects) {
    const originalStart = object.start,
      originalEnd = object.end;
    const replacement = replacements.get(object.id);
    if (replacement !== undefined) {
      parts.push(document.text.slice(consumed, originalStart), replacement);
      consumed = originalEnd;
      object.text = replacement;
      object.fingerprint = sourceFingerprint(replacement);
    }
    object.start = originalStart + offset;
    if (replacement !== undefined) offset += replacement.length - (originalEnd - originalStart);
    object.end = originalEnd + offset;
  }
  parts.push(document.text.slice(consumed));
  next.text = parts.join('');
  next.revision++;
  next.fingerprint = sourceFingerprint(next.text);
  next.history.push({
    revision: document.revision,
    name: document.name,
    text: document.text,
    objects: clone(document.objects),
    at: now,
    reason: 'object-edit',
  });
  validateNative(next);
  return next;
}

export function renameNative(
  document: NativeDocument,
  name: string,
  now = Date.now(),
): NativeDocument {
  if (nativeFormat(name) !== document.format) throw new Error('重命名不能隐式转换文件格式');
  const next = clone(document);
  next.history.push({
    revision: document.revision,
    name: document.name,
    text: document.text,
    objects: clone(document.objects),
    at: now,
    reason: 'rename',
  });
  next.name = name;
  next.revision++;
  return next;
}

/** Codepoint edits: independent symbols in a formula merge without treating the formula as one register. */
function analyzeTextChanges(
  base: string,
  changed: string,
): { changes: TextChange[]; ambiguous: boolean } {
  if (base === changed) return { changes: [], ambiguous: false };
  const a = Array.from(base),
    b = Array.from(changed);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const x = a.slice(prefix, a.length - suffix),
    y = b.slice(prefix, b.length - suffix);
  // Bound memory. Large ambiguous spans conservatively conflict rather than fabricate correspondence.
  if (x.length * y.length > 1_000_000)
    return {
      changes: [{ start: prefix, end: a.length - suffix, text: y.join('') }],
      ambiguous: true,
    };
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const firstPair = (si: number, sj: number): string => {
    while (si < x.length && sj < y.length) {
      if (x[si] === y[sj]) return `${si}:${sj}`;
      if (dp[si][sj + 1] > dp[si + 1][sj]) sj++;
      else si++;
    }
    return '';
  };
  const changes: TextChange[] = [];
  let i = 0,
    j = 0;
  let current: TextChange | undefined;
  let ambiguous = false;
  const finish = () => {
    if (current) changes.push(current);
    current = undefined;
  };
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      finish();
      i++;
      j++;
    } else {
      if (
        i < x.length &&
        j < y.length &&
        dp[i][j + 1] === dp[i + 1][j] &&
        dp[i][j + 1] > 0 &&
        firstPair(i, j + 1) !== firstPair(i + 1, j)
      )
        ambiguous = true;
      current ??= { start: prefix + i, end: prefix + i, text: '' };
      if (j < y.length && (i === x.length || dp[i][j + 1] > dp[i + 1][j])) current.text += y[j++];
      else {
        i++;
        current.end = prefix + i;
      }
    }
  }
  finish();
  // Prefix/suffix trimming must not conceal a second equally valid alignment in repeated symbols.
  for (const c of changes) {
    const inserted = Array.from(c.text);
    if (!inserted.length && c.start !== c.end) {
      if (
        (c.start > 0 && a[c.start - 1] === a[c.end - 1]) ||
        (c.end < a.length && a[c.start] === a[c.end])
      )
        ambiguous = true;
    } else if (c.start === c.end && inserted.length) {
      if (
        (c.start > 0 && a[c.start - 1] === inserted[inserted.length - 1]) ||
        (c.start < a.length && a[c.start] === inserted[0])
      )
        ambiguous = true;
    }
  }
  return { changes, ambiguous };
}
export function textChanges(base: string, changed: string): TextChange[] {
  return analyzeTextChanges(base, changed).changes;
}

const equalChange = (a: TextChange, b: TextChange) =>
  a.start === b.start && a.end === b.end && a.text === b.text;
function changesOverlap(a: TextChange, b: TextChange): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}
export function mergeNativeText(
  base: string,
  paper: string,
  source: string,
): { text?: string; conflict?: NativeConflict } {
  if (paper === source) return { text: paper };
  if (paper === base) return { text: source };
  if (source === base) return { text: paper };
  const pa = analyzeTextChanges(base, paper),
    sa = analyzeTextChanges(base, source);
  const paperChanges = pa.changes,
    sourceChanges = sa.changes;
  if (pa.ambiguous || sa.ambiguous)
    return {
      conflict: {
        base,
        paper,
        source,
        paperChanges,
        sourceChanges,
        kind: 'unverified-correspondence',
        reason: '重复符号或过大变化存在多种字符对应；须先确认，未伪装成精确映射',
      },
    };
  if (
    paperChanges.some((a) => sourceChanges.some((b) => !equalChange(a, b) && changesOverlap(a, b)))
  )
    return {
      conflict: {
        base,
        paper,
        source,
        paperChanges,
        sourceChanges,
        kind: 'contention',
        reason: '纸张与源文件修改了相同字符或插入位置',
      },
    };
  const merged = [
    ...paperChanges,
    ...sourceChanges.filter((b) => !paperChanges.some((a) => equalChange(a, b))),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const chars = Array.from(base),
    parts: string[] = [];
  let consumed = 0;
  for (const change of merged) {
    parts.push(chars.slice(consumed, change.start).join(''), change.text);
    consumed = change.end;
  }
  parts.push(chars.slice(consumed).join(''));
  return { text: parts.join('') };
}

export function createNativeLink(
  document: NativeDocument,
  objectId: string,
  options: { offlineTimeoutMs?: number; now?: number } = {},
): NativeLink {
  validateNative(document);
  const object = document.objects.find((o) => o.id === objectId);
  if (!object) throw new Error('找不到原生对象');
  const now = options.now ?? Date.now(),
    timeout = options.offlineTimeoutMs ?? 30 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('离线时限须为正数');
  return {
    schema: 1,
    id: uid(),
    sourceId: document.id,
    objectId,
    sourceName: document.name,
    sourceFingerprint: document.fingerprint,
    sourceRevision: document.revision,
    baseContent: object.text,
    paperContent: object.text,
    sourceSnapshot: clone(document),
    mode: 'linked',
    status: 'clean',
    offlineTimeoutMs: timeout,
    lastSourceContact: now,
    queued: [],
  };
}
export function editLinkedPaper(link: NativeLink, text: string, now = Date.now()): NativeLink {
  const next = clone(link);
  next.paperContent = text;
  if (next.mode === 'linked') {
    next.queued.push({ id: uid(), kind: 'edit', text, at: now });
    next.status = next.unavailableSince === undefined ? 'pending' : 'unavailable';
  }
  delete next.conflict;
  return next;
}

/** Call only for observed source-file access failures. Sync-server health must never call this function. */
export function markSourceUnavailable(link: NativeLink, now = Date.now()): NativeLink {
  const next = clone(link);
  if (next.mode !== 'linked') return next;
  next.unavailableSince ??= now;
  next.status = 'unavailable';
  if (now - next.unavailableSince >= next.offlineTimeoutMs) {
    next.mode = 'frozen';
    next.status = 'frozen';
    next.frozenAt = now;
  }
  return next;
}

function refreshed(
  link: NativeLink,
  document: NativeDocument,
  text: string,
  now: number,
): NativeLink {
  const next = clone(link);
  next.baseContent = text;
  next.paperContent = text;
  next.sourceSnapshot = clone(document);
  next.sourceName = document.name;
  next.sourceRevision = document.revision;
  next.sourceFingerprint = document.fingerprint;
  next.queued = [];
  next.status = next.deleted ? 'detached' : 'clean';
  next.lastSourceContact = now;
  delete next.unavailableSince;
  delete next.conflict;
  delete next.writeError;
  return next;
}

/** Plans an in-memory transaction. Persist document+link together, or use commitNativeWriteback for a real file. */
export function reconcileNativeLink(
  link: NativeLink,
  document: NativeDocument,
  now = Date.now(),
): LinkResult {
  validateNative(document);
  const next = clone(link);
  if (next.mode !== 'linked') return { link: next, document: clone(document) };
  if (document.id !== next.sourceId) throw new Error('源身份不一致；请显式重新定位');
  next.lastSourceContact = now;
  delete next.unavailableSince;
  const object = document.objects.find((o) => o.id === next.objectId);
  if (!object) {
    next.status = 'missing';
    next.lastSourceContact = now;
    delete next.unavailableSince;
    return { link: next, document: clone(document) };
  }
  if (next.queued.some((op) => op.kind === 'delete-source')) {
    if (object.text !== next.baseContent) {
      const conflict: NativeConflict = {
        base: next.baseContent,
        paper: '',
        source: object.text,
        paperChanges: textChanges(next.baseContent, ''),
        sourceChanges: textChanges(next.baseContent, object.text),
        reason: '待删除的源对象已被修改',
      };
      next.status = 'conflict';
      next.conflict = conflict;
      return { link: next, document: clone(document), conflict };
    }
    const removed = editNative(document, [{ objectId: object.id, replacement: '' }], now);
    removed.objects = removed.objects.filter((o) => o.id !== object.id);
    const done = refreshed(next, removed, '', now);
    done.mode = 'detached';
    done.status = 'detached';
    done.deleted = true;
    return { link: done, document: removed };
  }
  const result = mergeNativeText(next.baseContent, next.paperContent, object.text);
  if (result.conflict) {
    next.status = 'conflict';
    next.conflict = result.conflict;
    return { link: next, document: clone(document), conflict: result.conflict };
  }
  const updated =
    result.text === object.text
      ? clone(document)
      : editNative(document, [{ objectId: object.id, replacement: result.text! }], now);
  return { link: refreshed(next, updated, result.text!, now), document: updated };
}

/** A writer must reject a stale expected source before saving; failures retain the exact pending queue. */
export async function commitNativeWriteback(
  link: NativeLink,
  document: NativeDocument,
  write: (
    next: NativeDocument,
    expected: { fingerprint: string; text: string; revision: number },
  ) => Promise<void>,
  now = Date.now(),
): Promise<LinkResult> {
  const planned = reconcileNativeLink(link, document, now);
  if (planned.conflict || planned.document.text === document.text) return planned;
  try {
    await write(clone(planned.document), {
      fingerprint: document.fingerprint,
      text: document.text,
      revision: document.revision,
    });
    return planned;
  } catch (error) {
    const retained = clone(link),
      message = error instanceof Error ? error.message : String(error);
    retained.writeError = message;
    if (retained.mode === 'linked')
      retained.status = retained.unavailableSince === undefined ? 'pending' : 'unavailable';
    return { link: retained, document: clone(document), writeError: message };
  }
}

/** A UI must preview conflict.base/paper/source before invoking this explicit resolution. */
export function resolveNativeConflict(
  link: NativeLink,
  document: NativeDocument,
  chosenText: string,
  now = Date.now(),
): LinkResult {
  if (link.status !== 'conflict' || !link.conflict) throw new Error('没有待解决的源冲突');
  if (document.id !== link.sourceId) throw new Error('源身份不一致');
  const object = document.objects.find((o) => o.id === link.objectId);
  if (!object || object.text !== link.conflict.source)
    throw new Error('预览后源对象再次改变，请刷新冲突预览');
  const updated = editNative(document, [{ objectId: object.id, replacement: chosenText }], now);
  const done = refreshed(link, updated, chosenText, now);
  done.deleted = false;
  return { link: done, document: updated };
}

/** Exact contents + exact source span are required; a matching filename/fingerprint alone is insufficient. */
export function relinkNativeSource(
  link: NativeLink,
  candidate: NativeDocument,
  now = Date.now(),
): { matched: boolean; link: NativeLink; reason?: string } {
  validateNative(candidate);
  const next = clone(link);
  if (next.mode !== 'linked')
    return { matched: false, link: next, reason: '冻结或独立副本不会自动重新建立关联' };
  const snapshot = next.sourceSnapshot;
  if (candidate.format !== snapshot.format || candidate.text !== snapshot.text)
    return { matched: false, link: next, reason: '候选源内容不相同，保留原快照并等待人工定位' };
  const old = snapshot.objects.find((o) => o.id === next.objectId);
  const target =
    old &&
    candidate.objects.find(
      (o) => o.start === old.start && o.end === old.end && o.text === old.text,
    );
  if (!target) return { matched: false, link: next, reason: '候选源没有已验证的对应区间' };
  next.sourceId = candidate.id;
  next.objectId = target.id;
  next.sourceName = candidate.name;
  next.sourceSnapshot = clone(candidate);
  next.sourceRevision = candidate.revision;
  next.sourceFingerprint = candidate.fingerprint;
  next.lastSourceContact = now;
  delete next.unavailableSince;
  next.status = next.queued.length ? 'pending' : 'clean';
  return { matched: true, link: next };
}

/** The two explicit choices are intentionally separate. No default may delete source data. */
export function deleteLinkedObject(
  link: NativeLink,
  choice: 'detach' | 'delete-source',
  document?: NativeDocument,
  now = Date.now(),
): { link: NativeLink; document?: NativeDocument; conflict?: NativeConflict } {
  if (choice !== 'detach' && choice !== 'delete-source')
    throw new Error('须选择仅解除关联或同步删除源对象');
  const next = clone(link);
  if (choice === 'detach' || next.mode !== 'linked') {
    next.mode = 'detached';
    next.status = 'detached';
    next.deleted = true;
    return { link: next, document: document && clone(document) };
  }
  next.deleted = true;
  next.status = 'pending';
  next.queued.push({ id: uid(), kind: 'delete-source', text: '', at: now });
  return document ? reconcileNativeLink(next, document, now) : { link: next };
}

export const FORMAT_COVERAGE = [
  {
    format: 'Markdown',
    status: 'verified-source-regions',
    nativeWrite: true,
    limits: '源文本区间往返；不保证所有方言的富文本渲染',
  },
  {
    format: 'LaTeX',
    status: 'verified-source-regions',
    nativeWrite: true,
    limits: '源文本区间往返；不包含 TeX 编译器与宏展开语义',
  },
  {
    format: 'DOCX / XLSX / PPTX',
    status: 'not-implemented',
    nativeWrite: false,
    limits: '最终目标保留；对象、母版、公式、排版与动画均未验证',
  },
  {
    format: 'Keynote / Numbers',
    status: 'not-implemented',
    nativeWrite: false,
    limits: '最终目标保留；IWA/Protobuf、对象与母版语义均未验证',
  },
] as const;
