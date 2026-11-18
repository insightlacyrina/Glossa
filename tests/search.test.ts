import assert from 'node:assert/strict';
import test from 'node:test';
import { NotebookEngine } from '../src/domain.ts';
import {
  createSearchIndex,
  searchLocal,
  searchSemantic,
  type EmbeddingSearchConfig,
} from '../src/search.ts';

function notebook() {
  const engine = new NotebookEngine();
  const noteId = engine.createNote('  光学手记  ');
  const folderId = engine.createFolder('物理');
  engine.manageNote(noteId, { folderId, tags: ['课程'] });
  const pageId = engine.getNote(noteId).pages[0].id;
  const text = '🖋 e\u0301  ＡＢＣ 涉及反射和折射';
  const objectId = engine.addText(noteId, pageId, text);
  const blockId = engine.createBlock(noteId, '惯性定律', [objectId]);
  const segmentId = engine.recognize(noteId, blockId, [objectId], text, {
    deterministic: true,
  });
  const rawObjectId = engine.addText(noteId, pageId, '  重力  G＝ﬀ  ');
  const deleted = engine.addText(noteId, pageId, '删除后不能再检索');
  engine.deleteObject(noteId, deleted);
  const other = engine.createNote('表面张力');
  const otherPage = engine.getNote(other).pages[0].id;
  engine.addText(other, otherPage, '液滴形状');
  const index = () => createSearchIndex(engine.state.notes, engine.state.folders, folderId);
  return {
    engine,
    noteId,
    folderId,
    pageId,
    objectId,
    blockId,
    segmentId,
    rawObjectId,
    text,
    index,
  };
}

const preferences = (): EmbeddingSearchConfig => ({
  endpoint: 'https://api.example.test/v1',
  apiKey: 'fixture-key',
  model: 'fixture-embedding',
  consent: { granted: true, grantedAt: 1, scope: 'search-text' },
});

test('exact search highlights original Unicode ranges and preserves stable segment characters', () => {
  const { engine, noteId, pageId, objectId, blockId, segmentId, rawObjectId, text, index } =
    notebook();
  const entries = index();
  const hits = searchLocal(entries, 'É abc');
  assert.equal(hits.length, 1, 'an exact mapped copy of paper text appears once');
  const [hit] = hits;
  assert.equal(hit.folderName, '物理');
  assert.equal(hit.pageId, pageId);
  assert.equal(hit.pageNumber, 1);
  assert.equal(hit.segmentId, segmentId);
  assert.equal(hit.blockId, blockId);
  assert.deepEqual(hit.sourceObjectIds, [objectId]);
  assert.equal(hit.location?.text, text);
  const marked = hit.snippet.slice(hit.match?.start, hit.match?.end);
  assert.equal(marked, 'e\u0301  ＡＢＣ');
  const characters = engine
    .getNote(noteId)
    .blocks[0].segments[0].chars.filter((char) => hit.charIds?.includes(char.id));
  assert.equal(characters.map((char) => char.value).join(''), marked);
  assert.equal(searchLocal(entries, '惯性')[0].kind, 'concept');
  assert.equal(searchLocal(entries, '课程')[0].kind, 'tag');
  assert.equal(searchLocal(entries, '光学')[0].kind, 'title');
  assert.equal(searchLocal(entries, '液滴').length, 0, 'folder search is scoped');
  assert.equal(searchLocal(entries, '删除后').length, 0, 'deleted paper is excluded');
  const [ligature] = searchLocal(entries, 'f');
  assert.equal(searchLocal(entries, 'f').length, 1, 'expanded glyph has one real range');
  assert.equal(ligature.objectId, rawObjectId);
  assert.equal(ligature.snippet.slice(ligature.match?.start, ligature.match?.end), 'ﬀ');
});

test('embedding retrieval keeps local hits, validates consent, and reuses only scoped unchanged text', async () => {
  const { engine, noteId, pageId, rawObjectId, index } = notebook();
  const config = preferences();
  const inputs: string[][] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://api.example.test/v1/embeddings');
    assert.equal(init?.redirect, 'error');
    const { input: texts, model } = JSON.parse(String(init?.body));
    assert.equal(model, config.model);
    assert.ok(texts.length <= 24);
    assert.ok(texts.every((text: string) => !text.includes('液滴') && !text.includes('删除后')));
    inputs.push(texts);
    return Response.json({
      data: texts
        .map((text: string, index: number) => ({
          index,
          embedding: /速度保持|惯性/.test(text) ? [1, 0] : [0, 1],
        }))
        .reverse(),
    });
  };
  const signal = new AbortController().signal;
  const query = '速度保持';
  const run = (workspace: string) =>
    searchSemantic(index(), query, config, workspace, signal, undefined, fetcher);

  assert.equal(searchLocal(index(), query).length, 0);
  const results = await run('workspace:1');
  assert.ok(results.some((hit) => hit.kind === 'concept' && hit.snippet === '惯性定律'));
  assert.ok(
    results.every((hit) => !hit.match),
    'semantic snippets do not imply an exact text match',
  );
  const initial = inputs.length;
  assert.deepEqual(await run('workspace:1'), results);
  assert.equal(inputs.length, initial, 'repeat search does not resend queries or text');
  engine.updateObject(noteId, rawObjectId, { text: '变更过的重力公式' });
  await run('workspace:1');
  assert.deepEqual(
    inputs.slice(initial).flat(),
    ['光学手记\n变更过的重力公式'].map(
      (value) => engine.getNote(noteId).title + value.slice('光学手记'.length),
    ),
  );
  const edited = inputs.length;
  await run('workspace:2');
  assert.ok(
    inputs.slice(edited).flat().includes(query),
    'workspace change cannot reuse text or query vectors',
  );
  const authorized = inputs.length;
  await assert.rejects(
    searchSemantic(
      index(),
      query,
      { ...config, consent: { ...config.consent, granted: false } },
      'workspace:2',
      signal,
      undefined,
      fetcher,
    ),
    /请授权/,
  );
  assert.equal(inputs.length, authorized);
  assert.equal(searchLocal(index(), '重力')[0].pageId, pageId);
});

test('automatic embedding fallback recomputes the query and passages using the chosen model only', async () => {
  const { engine, noteId, pageId, index } = notebook();
  for (let i = 0; i < 29; i++) engine.addText(noteId, pageId, '不同的文字 ' + i);
  const config = preferences();
  config.model = '';
  const sent = { first: [] as string[][], second: [] as string[][] };
  config.auto = {
    async runEmbedding(signal, run) {
      signal.throwIfAborted();
      try {
        return await run('first', async (inputs) => {
          sent.first.push(inputs);
          if (sent.first.length > 1) throw new Error('fixture rate limit');
          return inputs.map(() => [1, 0]);
        });
      } catch (error) {
        assert.match(String(error), /fixture rate limit/);
        return run('second', async (inputs) => {
          sent.second.push(inputs);
          return inputs.map((text) => (/速度保持|惯性/.test(text) ? [0, 1] : [1, 0]));
        });
      }
    },
  };
  const results = await searchSemantic(
    index(),
    '速度保持',
    config,
    'workspace',
    new AbortController().signal,
  );
  assert.equal(sent.first[0][0], '速度保持');
  assert.deepEqual(
    sent.second[0],
    sent.first[0],
    'fallback re-embeds the same batch despite equal dimensions',
  );
  assert.ok(results.some((hit) => hit.kind === 'concept'));
  assert.ok(results.every((hit) => !hit.snippet.startsWith('不同的文字')));
});

test('an interrupted lookup aborts its transport and discards late vectors', async () => {
  const { index } = notebook();
  const controller = new AbortController();
  const reason = new DOMException('search replaced', 'AbortError');
  let started = false;
  const fetcher: typeof fetch = async (_input, init) => {
    started = true;
    controller.abort(reason);
    assert.equal(init?.signal?.aborted, true);
    return Response.json({ data: [] });
  };
  await assert.rejects(
    searchSemantic(
      index(),
      '速度保持',
      preferences(),
      'workspace',
      controller.signal,
      undefined,
      fetcher,
    ),
    (error) => error === reason,
  );
  assert.equal(started, true);
});
