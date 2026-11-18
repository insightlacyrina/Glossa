import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoModelRouter, GOOGLE_AI_STUDIO } from '../src/external-models.ts';

const source = [
  { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,ZmFrZQ==' } },
];
const googleModel = (id: string, ...methods: string[]) => ({
  name: 'models/' + id,
  displayName: id,
  supportedGenerationMethods: methods,
});
const vision = (value: string) =>
  Response.json({ candidates: [{ content: { parts: [{ text: value }] } }] });
const retry = (message: string, seconds = '12') =>
  Response.json({ error: { message } }, { status: 429, headers: { 'Retry-After': seconds } });
const noAbort = () => new AbortController().signal;

test('Google catalog follows pagination and selects only models with relevant capabilities', async () => {
  const calls: string[] = [];
  const router = new AutoModelRouter(GOOGLE_AI_STUDIO, 'fixture-key', async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-goog-api-key'), 'fixture-key');
    assert.equal(headers.has('Authorization'), false);
    assert.equal(url.searchParams.has('key'), false);
    if (url.pathname.endsWith('/models')) {
      if (url.searchParams.has('pageToken')) {
        assert.equal(url.searchParams.get('pageToken'), 'next+token');
        return Response.json({ models: [googleModel('gemini-embedding-001', 'embedContent')] });
      }
      return Response.json({
        models: [
          googleModel('gemini-2.5-flash-image', 'generateContent'),
          googleModel('gemini-2.5-flash', 'generateContent'),
          googleModel('gemini-2.0-tts', 'generateContent'),
          googleModel('gemini-3-synthetic', 'countTokens'),
        ],
        nextPageToken: 'next+token',
      });
    }
    const body = JSON.parse(String(init?.body));
    if (url.pathname.endsWith('gemini-embedding-001:batchEmbedContents')) {
      assert.equal(body.requests[0].model, 'models/gemini-embedding-001');
      assert.equal(body.requests[0].content.parts[0].text, '查询');
      return Response.json({ embeddings: [{ values: [1, 0] }] });
    }
    assert.ok(url.pathname.endsWith('gemini-2.5-flash:generateContent'));
    assert.deepEqual(body.contents[0].parts[0], {
      inlineData: { mimeType: 'image/png', data: 'ZmFrZQ==' },
    });
    return vision('文字');
  });
  try {
    assert.equal(await router.recognizeVision('读文字', source, noAbort()), '文字');
    const result = await router.runEmbedding(noAbort(), async (model, embed) => {
      assert.equal(model, 'gemini-embedding-001');
      return embed(['查询'], noAbort());
    });
    assert.deepEqual(result, [[1, 0]]);
    assert.equal(calls.filter((call) => call.startsWith('/v1beta/models?')).length, 1);
    assert.equal(calls.length, 4);
  } finally {
    router.dispose();
  }
});

test('per-model 429 falls back within the same capability and honors Retry-After', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const attempts: string[] = [];
  const router = new AutoModelRouter(GOOGLE_AI_STUDIO, 'fixture-key', async (input) => {
    const url = String(input);
    if (url.endsWith('/models'))
      return Response.json({
        models: [
          googleModel('gemini-2.5-flash', 'generateContent'),
          googleModel('gemini-2.0-flash', 'generateContent'),
          googleModel('gemini-embedding-001', 'embedContent'),
        ],
      });
    const id = url.split('/').at(-1)!.split(':')[0];
    attempts.push(id);
    if (id === 'gemini-2.5-flash' && attempts.length === 1) return retry('this model quota');
    return vision(id);
  });
  try {
    const recognize = () => router.recognizeVision('读取', source, noAbort());
    assert.equal(await recognize(), 'gemini-2.0-flash');
    now += 11_999;
    assert.equal(await recognize(), 'gemini-2.0-flash');
    now += 1;
    assert.equal(await recognize(), 'gemini-2.5-flash');
    assert.deepEqual(attempts, [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash',
      'gemini-2.5-flash',
    ]);
  } finally {
    router.dispose();
  }
});

test('project-wide 429 suppresses other model requests and stale catalogs', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let phase: 'initial' | 'generation-limit' | 'catalog-limit' = 'initial';
  let generations = 0;
  let embeddings = 0;
  const router = new AutoModelRouter(GOOGLE_AI_STUDIO, 'fixture-key', async (input) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      if (phase === 'catalog-limit') return retry('project-wide quota exhausted');
      return Response.json({
        models: [
          googleModel('gemini-2.5-flash', 'generateContent'),
          googleModel('gemini-2.0-flash', 'generateContent'),
          googleModel('gemini-embedding-001', 'embedContent'),
        ],
      });
    }
    if (url.endsWith(':batchEmbedContents')) {
      embeddings++;
      return Response.json({ embeddings: [{ values: [1, 0] }] });
    }
    generations++;
    return phase === 'generation-limit' ? retry('project-wide quota exhausted') : vision('结果');
  });
  try {
    const recognize = () => router.recognizeVision('读取', source, noAbort());
    const embed = () => router.runEmbedding(noAbort(), (_model, send) => send(['测试'], noAbort()));
    assert.equal(await recognize(), '结果');
    phase = 'generation-limit';
    await assert.rejects(recognize(), /限额/);
    await assert.rejects(embed(), /限额/);
    assert.equal(generations, 2);
    assert.equal(embeddings, 0);
    now += 300_001;
    phase = 'catalog-limit';
    await assert.rejects(recognize(), /限额/);
    assert.equal(
      generations,
      2,
      'catalog rate limit must block content submission via stale models',
    );
  } finally {
    router.dispose();
  }
});

test('an embedding batch rate limit retries the complete operation on a different model', async () => {
  const batches: { model: string; texts: string[] }[] = [];
  const router = new AutoModelRouter(
    'https://api.example.test/v1',
    'fixture-key',
    async (input, init) => {
      const url = String(input);
      if (url.endsWith('/models'))
        return Response.json({
          data: [
            { id: 'text-embedding-3-small' },
            { id: 'text-embedding-3-large' },
            { id: 'gpt-4o' },
          ],
        });
      assert.ok(url.endsWith('/embeddings'));
      const { model, input: texts } = JSON.parse(String(init?.body));
      batches.push({ model, texts });
      if (model.endsWith('small') && texts[0] === '笔记') return retry('model quota');
      return Response.json({
        data: [{ index: 0, embedding: model.endsWith('small') ? [1, 0] : [0, 1] }],
      });
    },
  );
  try {
    const signal = noAbort();
    const result = await router.runEmbedding(signal, async (model, embed) => {
      const query = await embed(['查询'], signal);
      const notes = await embed(['笔记'], signal);
      return { model, query, notes };
    });
    assert.deepEqual(result, {
      model: 'text-embedding-3-large',
      query: [[0, 1]],
      notes: [[0, 1]],
    });
    assert.deepEqual(
      batches.map(({ model, texts }) => [model.split('-').at(-1), texts[0]]),
      [
        ['small', '查询'],
        ['small', '笔记'],
        ['large', '查询'],
        ['large', '笔记'],
      ],
    );
  } finally {
    router.dispose();
  }
});

test('cancelled lookups and disposed routers stop embedding transport', async () => {
  let requests = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const router = new AutoModelRouter(GOOGLE_AI_STUDIO, 'fixture-key', async (input, init) => {
    if (String(input).endsWith('/models'))
      return Response.json({ models: [googleModel('gemini-embedding-001', 'embedContent')] });
    requests++;
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  try {
    await router.refresh();
    const lookup = new AbortController();
    const aborted = new DOMException('lookup replaced', 'AbortError');
    const late = router.runEmbedding(lookup.signal, (_model, embed) => {
      lookup.abort(aborted);
      return embed(['仍在等待的请求'], noAbort());
    });
    const checked = assert.rejects(late, (error) => error === aborted);
    await Promise.race([
      checked,
      started.then(() => {
        throw new Error('a cancelled lookup reached the embedding provider');
      }),
    ]);
    assert.equal(requests, 0);
    const active = router.runEmbedding(noAbort(), (_model, embed) =>
      embed(['正在发送'], noAbort()),
    );
    const stopped = assert.rejects(active, { name: 'AbortError' });
    await started;
    router.dispose();
    await stopped;
    await assert.rejects(router.refresh(), { name: 'AbortError' });
    assert.equal(requests, 1);
  } finally {
    router.dispose();
  }
});
