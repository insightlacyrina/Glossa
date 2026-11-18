import type { Character, Note, NotebookState } from './domain';
import { visibleObjects } from './Paper';

export type EmbeddingSearchConfig = {
  endpoint: string;
  model: string;
  apiKey: string;
  consent: { granted: boolean; scope: 'search-text'; grantedAt: number };
  auto?: {
    runEmbedding<T>(
      signal: AbortSignal,
      task: (
        modelId: string,
        embed: (inputs: string[], signal: AbortSignal) => Promise<number[][]>,
      ) => Promise<T>,
    ): Promise<T>;
  };
};

export type SearchRange = { start: number; end: number };
type SearchKind = 'title' | 'tag' | 'concept' | 'text' | 'formula' | 'reference';
type SearchTarget = {
  noteId: string;
  noteTitle: string;
  folderName: string;
  kind: SearchKind;
  label: string;
  blockId?: string;
  blockTitle?: string;
  segmentId?: string;
  pageId?: string;
  pageNumber?: number;
  objectId?: string;
  sourceObjectIds?: string[];
};
export type SearchHit = SearchTarget & {
  id: string;
  entryId: string;
  snippet: string;
  match?: SearchRange;
  location?: SearchRange & { text: string };
  charIds?: string[];
};

type Entry = SearchTarget & {
  id: string;
  text: string;
  normalized: string;
  chars?: Character[];
  exactCharacters?: boolean;
  objectPages?: ReadonlyMap<string, { pageId: string; pageNumber: number }>;
};

const labels: Record<SearchKind, string> = {
  title: '笔记标题',
  tag: '标签',
  concept: '概念',
  text: '文字',
  formula: '公式',
  reference: '引用',
};
const priority: Record<SearchKind, number> = {
  concept: 5,
  title: 4,
  tag: 3,
  formula: 2,
  text: 1,
  reference: 0,
};
const resultLimit = 72;
const normalize = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const graphemes =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

export function createSearchIndex(
  notes: readonly Note[],
  folders: readonly NotebookState['folders'][number][],
  folderId?: string | null,
): Entry[] {
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  const entries: Entry[] = [];
  for (const note of [...notes].sort((a, b) => b.modifiedAt - a.modifiedAt)) {
    if (folderId && note.folderId !== folderId) continue;
    const context = {
      noteId: note.id,
      noteTitle: note.title,
      folderName: folderNames.get(note.folderId ?? '') ?? '未归档',
    };
    function add(
      key: string,
      kind: SearchKind,
      text: string,
      target: Omit<Partial<Entry>, 'id' | 'text' | 'normalized' | 'kind'> = {},
    ) {
      const normalized = normalize(text);
      if (normalized)
        entries.push({
          ...context,
          ...target,
          id: JSON.stringify([note.id, key]),
          kind,
          label: labels[kind],
          text,
          normalized,
        });
    }

    const pages = new Map(
      note.pages.map((page, i) => [page.id, { pageId: page.id, pageNumber: i + 1 }]),
    );
    const visible = note.pages.flatMap(visibleObjects);
    const objectPages = new Map(visible.map((object) => [object.id, pages.get(object.pageId)!]));
    const representedTexts = new Map<string, Set<string>>();
    for (const block of note.blocks) {
      const blockTarget = { blockId: block.id, blockTitle: block.title };
      const blockPage = block.pageIds.map((id) => pages.get(id)).find(Boolean);
      add('block:' + block.id, 'concept', block.title, { ...blockTarget, ...blockPage });
      for (const segment of block.segments) {
        if (segment.deleted) continue;
        const exact = segment.source.status === 'exact';
        const sourceObjectIds = exact
          ? segment.source.objectIds.filter((id) => objectPages.has(id))
          : [];
        const page = sourceObjectIds.map((id) => objectPages.get(id)).find(Boolean) ?? blockPage;
        add('segment:' + segment.id, segment.kind, segment.text, {
          ...blockTarget,
          ...page,
          segmentId: segment.id,
          chars: segment.chars,
          exactCharacters: exact && segment.source.precision === 'character',
          objectPages,
          sourceObjectIds,
        });
        if (exact) {
          for (const id of segment.source.objectIds) {
            const texts = representedTexts.get(id) ?? new Set<string>();
            texts.add(segment.text);
            representedTexts.set(id, texts);
          }
        }
      }
    }
    for (const object of visible) {
      const text = object.text;
      if (!text || !['text', 'formula', 'reference'].includes(object.kind)) continue;
      if (
        representedTexts.get(object.id)?.has(text) ||
        object.replacesObjectIds?.some((id) => representedTexts.get(id)?.has(text))
      )
        continue;
      add('object:' + object.id, object.kind as 'text' | 'formula' | 'reference', text, {
        ...pages.get(object.pageId),
        objectId: object.id,
        sourceObjectIds: [object.id],
      });
    }
    add('title', 'title', note.title);
    for (const tag of new Set(note.tags)) add('tag:' + tag, 'tag', tag);
  }
  return entries;
}

function originalRange(entry: Entry, range: SearchRange): SearchRange {
  const { text, normalized } = entry;
  if (text === normalized && !/[\p{M}\u200d]/u.test(text)) return range;
  // Each normalized unit retains its source grapheme boundaries. For example, a
  // match inside the compatibility ligature “ﬁ” highlights the original glyph.
  let length = 0;
  let start: number | undefined;
  let blank: SearchRange | undefined;
  function append(origin: SearchRange, size: number) {
    length += size;
    if (start === undefined && length > range.start) start = origin.start;
    return length >= range.end;
  }
  const pieces =
    graphemes?.segment(text) ??
    (function* () {
      let index = 0;
      for (const segment of text) {
        yield { segment, index };
        index += segment.length;
      }
    })();
  for (const { segment, index } of pieces) {
    const origin = { start: index, end: index + segment.length };
    for (const unit of segment.normalize('NFKC').toLowerCase()) {
      if (/\s/u.test(unit)) {
        if (length) blank = { start: blank?.start ?? origin.start, end: origin.end };
        continue;
      }
      if (blank && append(blank, 1)) return { start: start!, end: blank.end };
      blank = undefined;
      if (append(origin, unit.length)) return { start: start!, end: origin.end };
    }
  }
  return { start: start ?? 0, end: text.length };
}

function safeBoundary(text: string, offset: number, forward = false) {
  const unit = text.charCodeAt(offset);
  return unit >= 0xdc00 && unit <= 0xdfff ? offset + (forward ? 1 : -1) : offset;
}

function makeHit(entry: Entry, occurrence?: SearchRange, passage?: SearchRange): SearchHit {
  const {
    id,
    text,
    normalized: _normalized,
    chars,
    exactCharacters,
    objectPages,
    ...target
  } = entry;
  const anchor = occurrence ?? passage;
  const start = safeBoundary(text, Math.max(0, (anchor?.start ?? 0) - (occurrence ? 44 : 0)));
  const end = safeBoundary(
    text,
    Math.min(
      text.length,
      occurrence
        ? Math.max(start + 132, occurrence.end + 42)
        : Math.min(start + 132, passage?.end ?? text.length),
    ),
    true,
  );
  const leading = start > 0 ? '…' : '';
  const trailing = end < text.length ? '…' : '';
  const snippet = leading + text.slice(start, end) + trailing;
  const hit: SearchHit = {
    ...target,
    id: id + ':' + (anchor?.start ?? 0),
    entryId: id,
    snippet,
    match: occurrence && {
      start: occurrence.start - start + leading.length,
      end: occurrence.end - start + leading.length,
    },
    location: occurrence && { ...occurrence, text },
  };
  if (chars && anchor) {
    const span = occurrence ?? { start, end };
    const selected: Character[] = [];
    let offset = 0;
    for (const char of chars) {
      if (char.deleted) continue;
      const next = offset + char.value.length;
      if (offset < span.end && next > span.start) selected.push(char);
      offset = next;
      if (offset >= span.end) break;
    }
    hit.charIds = selected.map((char) => char.id);
    if (exactCharacters) {
      const ids = [...new Set(selected.flatMap((char) => char.sourceObjectIds ?? []))].filter(
        (id) => objectPages?.has(id),
      );
      if (ids.length) {
        hit.sourceObjectIds = ids;
        Object.assign(hit, objectPages?.get(ids[0]));
      }
    }
  }
  return hit;
}

export function searchLocal(index: readonly Entry[], query: string): SearchHit[] {
  const phrase = normalize(query);
  if (!phrase) return [];
  const words = [...new Set(phrase.split(' '))];
  const matches: { entry: Entry; range: SearchRange; score: number }[] = [];
  for (const entry of index) {
    let start = entry.normalized.indexOf(phrase);
    const rank = priority[entry.kind];
    if (start < 0 && words.length > 1 && words.every((word) => entry.normalized.includes(word))) {
      const best = words.reduce((longest, word) => (word.length > longest.length ? word : longest));
      start = entry.normalized.indexOf(best);
      matches.push({ entry, range: { start, end: start + best.length }, score: rank });
    } else {
      for (let count = 0; start >= 0 && count < 3; count++) {
        matches.push({
          entry,
          range: { start, end: start + phrase.length },
          score: 10 + rank + (entry.normalized === phrase ? 5 : 0) - count,
        });
        start = entry.normalized.indexOf(phrase, start + phrase.length);
      }
    }
  }
  const hits = new Map<string, SearchHit>();
  for (const { entry, range } of matches.sort((a, b) => b.score - a.score)) {
    const hit = makeHit(entry, originalRange(entry, range));
    if (!hits.has(hit.id)) hits.set(hit.id, hit);
    if (hits.size === resultLimit) break;
  }
  return [...hits.values()];
}

function embeddingEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('请填写有效的向量模型 API 地址');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('向量模型服务须使用 HTTPS，本机服务可使用 HTTP');
  if (url.username || url.password || url.hash) throw new Error('向量模型 API 地址包含无效字段');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  url.pathname = path.endsWith('/embeddings') ? path : path + '/embeddings';
  return url.toString();
}

export function validateEmbeddingSearchConfig(config: EmbeddingSearchConfig) {
  if (
    !config.consent?.granted ||
    config.consent.scope !== 'search-text' ||
    !Number.isFinite(config.consent.grantedAt) ||
    config.consent.grantedAt <= 0
  )
    throw new Error('请授权将搜索词及笔记文字发送给此服务');
  embeddingEndpoint(config.endpoint);
  if ((!config.auto && !config.model.trim()) || !config.apiKey.trim())
    throw new Error('请填写向量模型名称与 API 密钥');
}

const batchSize = 24;
const chunkLength = 440;
const maxChunks = 240;
const maxResponseBytes = 6_000_000;
type Chunk = { entry: Entry; range: SearchRange; text: string };
type Vector = Float32Array;
type Cache = { provider: string; vectors: Map<string, Vector>; queries: Map<string, Vector> };
const caches = new WeakMap<EmbeddingSearchConfig, Map<string, Cache>>();

function getCache(config: EmbeddingSearchConfig, workspaceKey: string, modelId: string): Cache {
  const cacheKey = JSON.stringify([workspaceKey, modelId]);
  const provider = JSON.stringify([
    config.endpoint,
    modelId,
    config.apiKey,
    config.consent.grantedAt,
  ]);
  let projects = caches.get(config);
  if (!projects) {
    projects = new Map();
    caches.set(config, projects);
  }
  const previous = projects.get(cacheKey);
  if (previous?.provider === provider) return previous;
  const cache: Cache = { provider, vectors: new Map(), queries: new Map() };
  putBounded(projects, cacheKey, cache, 4);
  return cache;
}

function putBounded<T>(map: Map<string, T>, key: string, value: T, limit: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

function* passages(entries: Entry[]): Generator<Chunk> {
  for (const entry of entries) {
    const prefix = [entry.noteTitle, entry.blockTitle]
      .filter((value) => value && value !== entry.text)
      .map((value) => value!.slice(0, 64))
      .join('\n');
    for (let start = 0; start < entry.text.length; ) {
      const stop = Math.min(entry.text.length, start + chunkLength);
      let end = safeBoundary(entry.text, stop, true);
      if (stop < entry.text.length) {
        const line = Math.max(
          ...['\n', '。', '！', '？', '. ', '; '].map((separator) =>
            entry.text.lastIndexOf(separator, stop - 1),
          ),
        );
        if (line >= start + chunkLength * 0.65) end = line + 1;
      }
      const passage = entry.text.slice(start, end).trim();
      if (passage)
        yield {
          entry,
          range: { start, end },
          text: prefix ? prefix + '\n' + passage : passage,
        };
      if (end >= entry.text.length) break;
      start = safeBoundary(entry.text, end - 48, true);
    }
  }
}

function semanticChunks(index: readonly Entry[], exclude: ReadonlySet<string>) {
  const byNote = new Map<string, Entry[]>();
  for (const entry of index) {
    if (exclude.has(entry.id)) continue;
    const entries = byNote.get(entry.noteId) ?? [];
    entries.push(entry);
    byNote.set(entry.noteId, entries);
  }
  let cursors = [...byNote.values()].map(passages);
  const chunks: Chunk[] = [];
  // A long note must not consume every request before other notes are indexed.
  while (cursors.length && chunks.length < maxChunks) {
    const remaining: typeof cursors = [];
    for (const cursor of cursors) {
      const next = cursor.next();
      if (next.done) continue;
      chunks.push(next.value);
      if (chunks.length === maxChunks) break;
      remaining.push(cursor);
    }
    cursors = remaining;
  }
  return chunks;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('Content-Length')) > maxResponseBytes)
    throw new Error('向量服务响应过大或缺失');
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let body = '';
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new Error('向量服务响应过大');
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return JSON.parse(body + decoder.decode());
}

function normalizedVector(value: unknown): Vector {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 4096 ||
    !value.every((number) => typeof number === 'number' && Number.isFinite(number))
  )
    throw new Error('向量服务返回格式无效');
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('向量服务返回空向量');
  return Float32Array.from(value, (number) => number / norm);
}

async function embed(
  endpoint: string,
  config: EmbeddingSearchConfig,
  input: string[],
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Vector[]> {
  signal.throwIfAborted();
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.apiKey.trim(),
    },
    body: JSON.stringify({ model: config.model.trim(), input, encoding_format: 'float' }),
    signal,
  });
  if (!response.ok) throw new Error('向量服务请求失败');
  const { data } = (await boundedJson(response, signal)) as {
    data?: { index: number; embedding: unknown }[];
  };
  signal.throwIfAborted();
  if (!Array.isArray(data) || data.length !== input.length) throw new Error('向量服务返回数量不符');
  const vectors = new Map<number, Vector>();
  for (const row of data) {
    if (
      !row ||
      !Number.isInteger(row.index) ||
      row.index < 0 ||
      row.index >= input.length ||
      vectors.has(row.index)
    )
      throw new Error('向量服务返回索引无效');
    vectors.set(row.index, normalizedVector(row.embedding));
  }
  return input.map((_, index) => vectors.get(index)!);
}

function cosine(a: Vector, b: Vector) {
  let similarity = 0;
  for (let i = 0; i < a.length; i++) similarity += a[i] * b[i];
  return similarity;
}

type EmbeddingBatch = (inputs: string[], signal: AbortSignal) => Promise<Vector[]>;

async function rankWithEmbeddings(
  chunks: Chunk[],
  query: string,
  cache: Cache,
  send: EmbeddingBatch,
  signal: AbortSignal,
) {
  let queryVector = cache.queries.get(query);
  const texts = [...new Set(chunks.map((chunk) => chunk.text))];

  function store(batch: string[], vectors: Vector[], dimension: number) {
    signal.throwIfAborted();
    if (vectors.length !== batch.length || vectors.some((vector) => vector.length !== dimension)) {
      cache.queries.clear();
      cache.vectors.clear();
      throw new Error('向量模型返回的数量或维度不一致');
    }
    for (let i = 0; i < batch.length; i++) putBounded(cache.vectors, batch[i], vectors[i], 640);
  }

  if (!queryVector) {
    // Request the query with the first passages to avoid a round trip.
    const first = texts.filter((text) => !cache.vectors.has(text)).slice(0, batchSize - 1);
    const [vector, ...documents] = await send([query, ...first], signal);
    if (!vector) throw new Error('向量模型未返回搜索词向量');
    store(first, documents, vector.length);
    queryVector = vector;
    putBounded(cache.queries, query, vector, 32);
  }
  const dimension = queryVector.length;
  const missing = texts.filter((text) => cache.vectors.get(text)?.length !== dimension);
  const vectors = new Map(
    texts.flatMap((text) => {
      const vector = cache.vectors.get(text);
      return vector?.length === dimension ? [[text, vector] as const] : [];
    }),
  );
  async function load(batch: string[]) {
    if (!batch.length) return;
    const result = await send(batch, signal);
    store(batch, result, dimension);
    for (let i = 0; i < batch.length; i++) vectors.set(batch[i], result[i]);
  }
  for (let offset = 0; offset < missing.length; offset += batchSize * 2) {
    await Promise.all([
      load(missing.slice(offset, offset + batchSize)),
      load(missing.slice(offset + batchSize, offset + batchSize * 2)),
    ]);
  }

  signal.throwIfAborted();
  const ranked = chunks
    .map((chunk) => ({ chunk, score: cosine(queryVector, vectors.get(chunk.text)!) }))
    .sort((a, b) => b.score - a.score);
  const threshold = Math.max(0.36, (ranked[0]?.score ?? 0) - 0.16);
  const ids = new Set<string>();
  const hits: SearchHit[] = [];
  for (const { chunk, score } of ranked) {
    if (score < threshold || hits.length >= 16) break;
    if (ids.has(chunk.entry.id)) continue;
    ids.add(chunk.entry.id);
    hits.push(makeHit(chunk.entry, undefined, chunk.range));
  }
  return hits;
}

export async function searchSemantic(
  index: readonly Entry[],
  query: string,
  config: EmbeddingSearchConfig,
  workspaceKey: string,
  signal: AbortSignal,
  exclude: ReadonlySet<string> = new Set(),
  fetcher: typeof fetch = fetch,
): Promise<SearchHit[]> {
  validateEmbeddingSearchConfig(config);
  signal.throwIfAborted();
  const trimmedQuery = query.trim();
  const boundedQuery = trimmedQuery.slice(0, safeBoundary(trimmedQuery, 256, true));
  if (!boundedQuery) return [];
  const chunks = semanticChunks(index, exclude);
  if (!chunks.length) return [];
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(16_000)]);

  async function runModel(modelId: string, send: EmbeddingBatch) {
    const attempt = new AbortController();
    try {
      // A fallback must recompute the query and passages in its own vector space.
      return await rankWithEmbeddings(
        chunks,
        boundedQuery,
        getCache(config, workspaceKey, modelId),
        send,
        AbortSignal.any([requestSignal, attempt.signal]),
      );
    } finally {
      attempt.abort();
    }
  }

  if (config.auto)
    return config.auto.runEmbedding(requestSignal, (modelId, send) =>
      runModel(modelId, async (inputs, attemptSignal) => {
        const vectors = await send(inputs, attemptSignal);
        if (!Array.isArray(vectors)) throw new Error('向量模型返回格式无效');
        return vectors.map(normalizedVector);
      }),
    );

  const endpoint = embeddingEndpoint(config.endpoint);
  return runModel(config.model.trim(), (inputs, attemptSignal) =>
    embed(endpoint, config, inputs, attemptSignal, fetcher),
  );
}
