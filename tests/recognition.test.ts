import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRecognitionObjects, validateLocalCandidate } from '../src/recognition.ts';
import { IncrementalProcessor, type RecognitionResult } from '../src/automation.ts';

const stroke = (id: string, x: number, y: number, pageId = 'page') => ({
  id,
  revision: `v:${id}`,
  noteId: 'note',
  pageId,
  kind: 'stroke' as const,
  points: [
    { x, y, time: 1 },
    { x: x + 10, y: y + 24, time: 2 },
  ],
});

test('line recognition groups neighboring pen strokes but keeps pages and distant lines separate', () => {
  const groups = groupRecognitionObjects([
    stroke('a', 10, 20),
    stroke('b', 25, 20),
    stroke('c', 10, 180),
    stroke('d', 10, 20, 'other'),
  ]);
  assert.deepEqual(
    groups.map((group) => group.objectIds),
    [['a', 'b'], ['c'], ['d']],
  );
  assert.deepEqual(groups[0].sourceRevisions, { a: 'v:a', b: 'v:b' });
});

test('native multi-stroke result retains all exact source revisions and never fabricates confidence or mapping', async () => {
  let calls = 0;
  const processor = new IncrementalProcessor({
    idleMs: 60_000,
    localRecognizer: async (group, signal) => {
      calls++;
      assert.equal(signal.aborted, false);
      assert.deepEqual(group.objectIds, ['a', 'b']);
      return { text: '文字', candidates: ['文宇'], engine: 'mlkit-digital-ink' };
    },
  });
  processor.markDirty([stroke('a', 10, 20), stroke('b', 25, 20)]);
  const results = (await processor.flush()).filter((result) => result.stage === 'ocr');
  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].sourceObjectIds, ['a', 'b']);
  assert.deepEqual(results[0].sourceRevisions, { a: 'v:a', b: 'v:b' });
  assert.equal(results[0].mapping, 'unmapped');
  assert.equal(results[0].status, 'needs-review');
  assert.equal(results[0].confidence, undefined);
  assert.deepEqual(results[0].candidates, ['文字', '文宇']);
  processor.dispose();
});

test('missing downloaded model remains actionable and does not upload without a provider consent', async () => {
  const processor = new IncrementalProcessor({
    idleMs: 60_000,
    localRecognizer: async () => {
      throw Object.assign(new Error('请下载中文手写模型'), { code: 'MODEL_NOT_DOWNLOADED' });
    },
    fetcher: async () => {
      throw new Error('must never upload');
    },
  });
  processor.markDirty([stroke('a', 10, 20)]);
  const result = (await processor.flush()).find((result) => result.stage === 'ocr')!;
  assert.equal(result.status, 'unconfigured');
  assert.match(result.reason!, /下载中文/);
  assert.equal(processor.status.ocr.state, 'unconfigured');
  processor.dispose();
});

test('vision request carries real image parts with source labels and rejects duplicate or unknown IDs', async () => {
  let body: any;
  const processor = new IncrementalProcessor({
    idleMs: 60_000,
    provider: {
      endpoint: 'https://example.com/v1',
      model: 'vision',
      apiKey: 'key',
      consent: { granted: true, scope: 'changed-objects' },
    },
    rasterizer: async (group) => {
      assert.equal(group.objects.length, 2);
      return 'data:image/png;base64,aGVsbG8=';
    },
    fetcher: (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  objects: [
                    { objectId: 'a', text: 'one', confidence: 0.99 },
                    { objectId: 'a', text: 'two', confidence: 0.99 },
                    { objectId: 'invented', text: 'three' },
                  ],
                }),
              },
            },
          ],
        }),
      );
    }) as typeof fetch,
  });
  processor.markDirty([stroke('a', 10, 20), stroke('b', 25, 20)]);
  const result = (await processor.flush()).find((result) => result.stage === 'ocr')!;
  assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
  assert.ok(!JSON.stringify(body).includes('points'));
  assert.equal(result.text, undefined);
  assert.equal(result.mapping, 'unmapped');
  processor.dispose();
});

test('revoking provider aborts in-flight work and suppresses stale output while preserving a retry', async () => {
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: RecognitionResult[][] = [];
  const processor = new IncrementalProcessor({
    idleMs: 60_000,
    onResults: (results) => batches.push(results),
    localRecognizer: async (_group, requestSignal) => {
      signal = requestSignal;
      await gate;
      return { text: 'stale' };
    },
  });
  processor.markDirty([stroke('a', 10, 20)]);
  const running = processor.flush();
  processor.configure({ localRecognizer: undefined });
  assert.equal(signal?.aborted, true);
  release();
  await running;
  assert.equal(batches.length, 0);
  const retry = await processor.flush();
  assert.equal(retry.find((result) => result.stage === 'ocr')?.status, 'unconfigured');
  processor.dispose();
});

test('candidate validation abstains for empty, oversized, or impossible confidence without changing text', () => {
  assert.throws(() => validateLocalCandidate({ text: ' ', confidence: 1 }));
  assert.throws(() => validateLocalCandidate({ text: '字', confidence: NaN }));
  assert.throws(() => validateLocalCandidate({ text: '字', confidence: 1.1 }));
  assert.equal(validateLocalCandidate({ text: '1+1=3' }).text, '1+1=3');
});

test('a later bridge stroke joins neighboring existing groups without changing pen order', () => {
  const groups = groupRecognitionObjects([
    stroke('left', 0, 20),
    stroke('right', 140, 20),
    {
      ...stroke('bridge', 55, 20),
      points: [
        { x: 55, y: 20 },
        { x: 100, y: 44 },
      ],
    },
  ]);
  assert.deepEqual(
    groups.map((group) => group.objectIds),
    [['left', 'right', 'bridge']],
  );
});

test('explicit recognition scopes keep neighboring already-linked segments separate', () => {
  const groups = groupRecognitionObjects([
    { ...stroke('a', 10, 20), recognitionScope: 'segment:a' },
    { ...stroke('b', 25, 20), recognitionScope: 'segment:b' },
    stroke('new', 40, 20),
  ]);
  assert.deepEqual(
    groups.map((group) => group.objectIds),
    [['a'], ['b'], ['new']],
  );
});

test('an OCR backend failure does not mark an unrelated formula stage as failed', async () => {
  const processor = new IncrementalProcessor({
    idleMs: 60_000,
    localRecognizer: async () => {
      throw new Error('native-failed');
    },
  });
  processor.markDirty([stroke('a', 10, 20)]);
  await processor.flush();
  assert.equal(processor.status.ocr.state, 'error');
  assert.equal(processor.status.formula.state, 'ready');
  assert.equal(processor.status.formula.error, undefined);
  processor.dispose();
});
