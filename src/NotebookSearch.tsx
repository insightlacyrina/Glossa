import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import type { Note, NotebookState } from './domain';
import {
  createSearchIndex,
  searchLocal,
  searchSemantic,
  type EmbeddingSearchConfig,
  type SearchHit,
} from './search';
import './notebook-search.css';

type Props = {
  projectId: string;
  workspaceKey?: string;
  notes: readonly Note[];
  folders: readonly NotebookState['folders'][number][];
  folderId?: string | null;
  query: string;
  composing?: boolean;
  embedding?: EmbeddingSearchConfig;
  onOpen: (hit: SearchHit) => void;
};

type SemanticResults = {
  index: ReturnType<typeof createSearchIndex>;
  query: string;
  workspace: string;
  config: EmbeddingSearchConfig;
  hits: SearchHit[];
  failed: boolean;
};

function Snippet({ hit }: { hit: SearchHit }) {
  if (!hit.match) return <p className="search-hit-snippet">{hit.snippet}</p>;
  const { start, end } = hit.match;
  return (
    <p className="search-hit-snippet">
      {hit.snippet.slice(0, start)}
      <mark>{hit.snippet.slice(start, end)}</mark>
      {hit.snippet.slice(end)}
    </p>
  );
}

export function NotebookSearch({
  projectId,
  workspaceKey,
  notes,
  folders,
  folderId,
  query,
  composing = false,
  embedding,
  onOpen,
}: Props) {
  const text = query.trim();
  const workspace = JSON.stringify([projectId, workspaceKey ?? '']);
  const index = useMemo(
    () => createSearchIndex(notes, folders, folderId),
    [notes, folders, folderId],
  );
  const local = useMemo(() => searchLocal(index, text), [index, text]);
  const [semantic, setSemantic] = useState<SemanticResults>();
  const online = Boolean(embedding && text && index.length && !composing);
  const current =
    online &&
    semantic?.index === index &&
    semantic.query === text &&
    semantic.workspace === workspace &&
    semantic.config === embedding
      ? semantic
      : undefined;

  useEffect(() => {
    if (!embedding || !online) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const snapshot = { index, query: text, workspace, config: embedding };
      try {
        const hits = await searchSemantic(
          index,
          text,
          embedding,
          workspace,
          controller.signal,
          new Set(local.map((hit) => hit.entryId)),
        );
        if (!controller.signal.aborted) setSemantic({ ...snapshot, hits, failed: false });
      } catch {
        if (!controller.signal.aborted) setSemantic({ ...snapshot, hits: [], failed: true });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [embedding, index, local, online, text, workspace]);

  if (!text) return null;
  const groups = new Map<string, SearchHit[]>();
  for (const hit of [...local, ...(current?.hits ?? [])]) {
    const group = groups.get(hit.noteId) ?? [];
    group.push(hit);
    groups.set(hit.noteId, group);
  }
  const pending = online && !current;
  return (
    <section
      className="notebook-search-results"
      aria-label="搜索结果"
      aria-busy={pending && !groups.size}
    >
      {Array.from(groups, ([id, hits]) => (
        <article className="search-note-result" key={id} aria-label={hits[0].noteTitle}>
          <div className="search-note-heading">
            <h2>{hits[0].noteTitle}</h2>
            <span>{hits[0].folderName}</span>
          </div>
          <ul>
            {hits.map((hit) => (
              <li key={hit.id}>
                <button className="search-hit" type="button" onClick={() => onOpen(hit)}>
                  <div>
                    <div className="search-hit-location">
                      <span>{hit.label}</span>
                      {hit.blockTitle && hit.kind !== 'concept' && <span>{hit.blockTitle}</span>}
                      {hit.pageNumber && <span>第 {hit.pageNumber} 页</span>}
                    </div>
                    <Snippet hit={hit} />
                  </div>
                  <ArrowUpRight size={17} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </article>
      ))}
      {!groups.size && (
        <div className="search-results-empty" role="status">
          <Search size={22} aria-hidden="true" />
          <h2>{pending ? '正在查找相关内容' : '未找到相关内容'}</h2>
          {!pending && (
            <p>
              {current?.failed
                ? '仍可按关键词查找，试试笔记里的原词。'
                : '试试更短的词、公式或笔记标题。'}
            </p>
          )}
        </div>
      )}
      {groups.size > 0 && current?.failed && (
        <p className="search-results-fallback" role="status">
          相关内容暂时无法扩展，仍可按关键词查找。
        </p>
      )}
    </section>
  );
}
