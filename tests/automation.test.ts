import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IncrementalProcessor,
  classifyExistingFolder,
  straightenLine,
  proposeTypoCorrections,
  validateAIConfig,
  type RecognitionResult,
} from '../src/automation.ts';

test('idle recognition is incremental, no backend preserves handwriting as unmapped', async () => {
  const batches: RecognitionResult[][] = [];
  const processor = new IncrementalProcessor({
    idleMs: 5,
    onResults: (results) => batches.push(results),
  });
  processor.markDirty([{ id: 'stroke-1', revision: 1, kind: 'stroke', points: [{ x: 1, y: 1 }] }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].find((r) => r.stage === 'ocr'),
    {
      objectId: 'stroke-1',
      revision: 1,
      stage: 'ocr',
      status: 'unconfigured',
      mapping: 'unmapped',
      text: undefined,
      confidence: undefined,
      candidates: [],
      reason: '未配置识别服务；保留原始笔迹与对象',
    },
  );
  processor.markDirty([{ id: 'stroke-2', revision: 1, kind: 'stroke' }]);
  const next = await processor.closeNote();
  assert.ok(next.every((result) => result.objectId === 'stroke-2'));
  processor.dispose();
});

test('dirty revisions coalesce and disabled stages never execute', async () => {
  const processor = new IncrementalProcessor({
    idleMs: 60000,
    stages: {
      ocr: false,
      formula: false,
      classification: false,
      layout: false,
      structure: false,
      review: true,
    },
  });
  processor.markDirty([{ id: 'same', revision: 1, kind: 'text', text: 'old' }]);
  processor.markDirty([{ id: 'same', revision: 2, kind: 'text', text: 'new' }]);
  const results = await processor.flush();
  assert.equal(results.length, 1);
  assert.equal(results[0].revision, 2);
  assert.equal(results[0].stage, 'review');
  assert.equal(processor.status.ocr.state, 'disabled');
  assert.equal(processor.status.review.processed, 1);
  processor.dispose();
});

test('text extraction is faithful and typed formula content is protected', async () => {
  const processor = new IncrementalProcessor({ idleMs: 60000 });
  processor.markDirty([
    { id: 'formula', revision: 1, kind: 'formula', text: '1+1=3' },
    { id: 'text', revision: 1, kind: 'text', text: '原文不总结。推导保留。' },
  ]);
  const results = await processor.flush();
  assert.equal(results.find((r) => r.stage === 'formula')?.text, '1+1=3');
  assert.equal(
    results.find((r) => r.objectId === 'text' && r.stage === 'ocr')?.text,
    '原文不总结。推导保留。',
  );
  assert.equal(results.find((r) => r.stage === 'formula')?.mapping, 'exact-object');
  processor.dispose();
});

test('AI requires first-use explicit authorization and HTTPS', () => {
  assert.throws(
    () =>
      validateAIConfig({
        endpoint: 'https://example.com/v1',
        model: 'm',
        apiKey: 'k',
        consent: { granted: false, scope: 'changed-objects' },
      }),
    /授权/,
  );
  assert.throws(
    () =>
      validateAIConfig({
        endpoint: 'http://example.com/v1',
        model: 'm',
        apiKey: 'k',
        consent: { granted: true, scope: 'changed-objects' },
      }),
    /HTTPS/,
  );
  assert.doesNotThrow(() =>
    validateAIConfig({
      endpoint: 'http://127.0.0.1:8080/v1',
      model: 'm',
      apiKey: 'k',
      consent: { granted: true, scope: 'changed-objects' },
    }),
  );
});

test('external AI sends changed objects only and even confident output stays unmapped', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const processor = new IncrementalProcessor({
    idleMs: 60000,
    rasterizer: async () => 'data:image/png;base64,aGVsbG8=',
    provider: {
      endpoint: 'https://example.com/v1',
      model: 'model',
      apiKey: 'private-key',
      consent: { granted: true, grantedAt: Date.now(), scope: 'changed-objects' },
    },
    fetcher: (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      await gate;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  objects: [
                    { objectId: 'stroke', text: 'x²+y²', confidence: 1 },
                    { objectId: 'fabricated', text: 'extra', confidence: 1 },
                  ],
                }),
              },
            },
          ],
        }),
      );
    }) as typeof fetch,
  });
  processor.markDirty([
    { id: 'stroke', revision: 1, kind: 'stroke', points: [{ x: 1, y: 2, pressure: 0.7 }] },
  ]);
  const first = processor.flush();
  processor.markDirty([{ id: 'text2', revision: 2, kind: 'text', text: 'later' }]);
  release();
  const results = await first;
  const candidate = results.find((r) => r.stage === 'ocr');
  assert.equal(candidate?.mapping, 'unmapped');
  assert.equal(candidate?.status, 'needs-review');
  assert.equal(candidate?.confidence, 1);
  assert.ok(!JSON.stringify(requestBody).includes('text2'));
  assert.ok(!results.some((r) => r.objectId === 'fabricated'));
  const second = await processor.flush();
  assert.ok(second.every((r) => r.objectId === 'text2'));
  processor.dispose();
});

test('AI API failure remains visible and preserves original candidate reference', async () => {
  const processor = new IncrementalProcessor({
    idleMs: 60000,
    rasterizer: async () => 'data:image/png;base64,aGVsbG8=',
    provider: {
      endpoint: 'https://example.com/v1',
      model: 'm',
      apiKey: 'k',
      consent: { granted: true, scope: 'changed-objects' },
    },
    fetcher: (async () => new Response('', { status: 503 })) as typeof fetch,
  });
  processor.markDirty([{ id: 'ink', revision: 9, kind: 'stroke' }]);
  const results = await processor.flush();
  assert.equal(processor.status.ocr.state, 'error');
  assert.equal(results.find((r) => r.stage === 'ocr')?.objectId, 'ink');
  assert.match(results.find((r) => r.stage === 'ocr')?.reason ?? '', /503/);
  processor.dispose();
});

test('folder classification chooses only uniquely matching existing folders', () => {
  const folders = [
    { id: 'math', name: '数学', keywords: ['积分', '矩阵'] },
    { id: 'chem', name: '化学', keywords: ['反应', '分子'] },
  ];
  assert.equal(classifyExistingFolder('矩阵与积分', folders), 'math');
  assert.equal(classifyExistingFolder('未分类', folders), undefined);
  assert.equal(classifyExistingFolder('积分与分子', folders), undefined);
});

test('geometry algorithm preserves pressure and tilt and abstains for curves', () => {
  const source = [
    { x: 0, y: 0, pressure: 0.3, tiltX: 8 },
    { x: 50, y: 1, pressure: 0.8, tiltX: 12 },
    { x: 100, y: 0, pressure: 0.5, tiltX: 9 },
  ];
  const straight = straightenLine(source);
  assert.equal(straight[1].y, 0);
  assert.equal(straight[1].pressure, 0.8);
  assert.equal(straight[1].tiltX, 12);
  assert.equal(source[1].y, 1);
  const curved = [
    { x: 0, y: 0 },
    { x: 40, y: 60 },
    { x: 100, y: 0 },
  ];
  assert.deepEqual(straightenLine(curved), curved);
});

test('only allowlisted very high confidence prose typos are eligible; formulas and facts never autocorrect', () => {
  const rules = [
    { id: 'common', from: 'teh', to: 'the', confidence: 0.999 },
    { id: 'uncertain', from: 'could', to: 'should', confidence: 0.8 },
  ];
  assert.equal(proposeTypoCorrections('teh could', 'prose', rules).length, 1);
  assert.deepEqual(proposeTypoCorrections('teh', 'formula', rules), []);
  assert.deepEqual(proposeTypoCorrections('teh', 'fact', rules), []);
  assert.deepEqual(proposeTypoCorrections('teh', 'prose', rules)[0].undo, {
    expected: 'the',
    restore: 'teh',
  });
});

test('a long new stroke suspends old idle work and explicitly reports busy without dropping dirty objects', async () => {
  const batches: RecognitionResult[][] = [];
  const processor = new IncrementalProcessor({
    idleMs: 10,
    onResults: (results) => batches.push(results),
  });
  processor.markDirty([{ id: 'previous-stroke', revision: 1, kind: 'stroke' }]);
  processor.setWriting(true);
  processor.markDirty([{ id: 'new-object', revision: 1, kind: 'text', text: '完整原文' }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(batches.length, 0);
  assert.equal(processor.status.ocr.processed, 0);
  const manual = await processor.flush('manual');
  assert.equal(manual.busy, true);
  assert.equal(manual.length, 0);
  assert.equal(processor.isWriting, true);
  processor.setWriting(false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(batches.length, 1);
  assert.deepEqual([...new Set(batches[0].map((result) => result.objectId))].sort(), [
    'new-object',
    'previous-stroke',
  ]);
  processor.dispose();
});

test('in-flight recognition is buffered throughout handwriting and published only after end plus idle', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: RecognitionResult[][] = [];
  const processor = new IncrementalProcessor({
    idleMs: 30,
    onResults: (results) => batches.push(results),
    rasterizer: async () => 'data:image/png;base64,aGVsbG8=',
    provider: {
      endpoint: 'https://example.com/v1',
      model: 'm',
      apiKey: 'k',
      consent: { granted: true, scope: 'changed-objects' },
    },
    fetcher: (async () => {
      await gate;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  objects: [{ objectId: 'in-flight', text: '候选原意', confidence: 0.97 }],
                }),
              },
            },
          ],
        }),
      );
    }) as typeof fetch,
  });
  processor.markDirty([{ id: 'in-flight', revision: 2, kind: 'stroke' }]);
  const running = processor.flush();
  processor.setWriting(true);
  release();
  assert.equal((await running).busy, true);
  assert.equal(batches.length, 0);
  processor.setWriting(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(batches.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(batches.length, 1);
  const candidate = batches[0].find((result) => result.stage === 'ocr');
  assert.equal(candidate?.text, '候选原意');
  assert.equal(candidate?.mapping, 'unmapped');
  assert.equal(candidate?.revision, 2);
  processor.dispose();
});

test('close explicitly flushes paused changes, while disposal never publishes a revoked in-flight result', async () => {
  let callbacks = 0;
  const processor = new IncrementalProcessor({
    idleMs: 60000,
    onResults: () => {
      callbacks++;
    },
  });
  processor.setWriting(true);
  processor.markDirty([{ id: 'closing', revision: 1, kind: 'text', text: '保留' }]);
  const closed = await processor.closeNote();
  assert.equal(closed.busy, false);
  assert.equal(callbacks, 1);
  assert.equal(processor.isWriting, false);
  processor.dispose();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revoked = new IncrementalProcessor({
    onResults: () => {
      callbacks++;
    },
    rasterizer: async () => 'data:image/png;base64,aGVsbG8=',
    provider: {
      endpoint: 'https://example.com/v1',
      model: 'm',
      apiKey: 'k',
      consent: { granted: true, scope: 'changed-objects' },
    },
    fetcher: (async () => {
      await gate;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"objects":[]}' } }] }),
      );
    }) as typeof fetch,
  });
  revoked.markDirty([{ id: 'revoked', revision: 1, kind: 'stroke' }]);
  const inFlight = revoked.flush();
  revoked.dispose();
  release();
  await inFlight;
  assert.equal(callbacks, 1);
});

test('disabling every stage suppresses empty publication and cannot create an idle requeue loop', async () => {
  let callbacks = 0;
  const object = { id: 'disabled', revision: 1, kind: 'stroke' as const };
  const processor = new IncrementalProcessor({
    idleMs: 2,
    stages: {
      ocr: false,
      formula: false,
      classification: false,
      layout: false,
      structure: false,
      review: false,
    },
    onResults: () => {
      callbacks++;
      processor.markDirty([object]);
    },
  });
  processor.markDirty([object]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(callbacks, 0);
  assert.equal((await processor.flush()).length, 0);
  processor.dispose();
});
