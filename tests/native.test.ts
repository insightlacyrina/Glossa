import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportNativeText, nativeRequest } from '../src/native.ts';

test('native full-project export chunks more than 16MiB without changing Unicode or surrogate boundaries', async () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  const hash = createHash('sha256');
  let sequence = 0,
    total = 0,
    maxChunk = 0;
  function reply(id: string, extra: Record<string, unknown> = {}) {
    queueMicrotask(() =>
      target.dispatchEvent(
        new CustomEvent('quietpaper-native', {
          detail: { requestId: id, ok: true, type: 'export', ...extra },
        }),
      ),
    );
  }
  const bridge = {
    beginExport(id: string) {
      reply(id, { sessionId: 'test-session' });
    },
    appendExportChunk(id: string, session: string, order: string, encoded: string) {
      assert.equal(session, 'test-session');
      assert.equal(Number(order), sequence++);
      const bytes = Buffer.from(encoded, 'base64');
      assert.ok(bytes.length <= 256 * 1024);
      hash.update(bytes);
      total += bytes.length;
      maxChunk = Math.max(maxChunk, bytes.length);
      reply(id, { bytes: total, sequence });
    },
    completeExport(id: string, session: string) {
      assert.equal(session, 'test-session');
      reply(id, { sha256: hash.digest('hex'), bytes: total });
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(target, { QuietPaperNative: bridge }),
  });
  try {
    const text = 'a'.repeat(65535) + '𝛼' + '中文 ✍️ 𝛽 ∫ x² dx\n'.repeat(900_000);
    const result = await exportNativeText('完整工程.quietpaper', text);
    assert.ok(total > 16 * 1024 * 1024);
    assert.ok(sequence > 100);
    assert.ok(maxChunk <= 256 * 1024);
    assert.equal(result.sha256, createHash('sha256').update(text, 'utf8').digest('hex'));
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});

test('synchronous native failure removes the listener and rejects the request', async () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  let added = 0,
    removed = 0;
  const add = target.addEventListener.bind(target),
    remove = target.removeEventListener.bind(target);
  target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
    added++;
    return add(...args);
  };
  target.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>) => {
    removed++;
    return remove(...args);
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(target, {
      QuietPaperNative: {
        openDocument() {
          throw new Error('bridge unavailable');
        },
      },
    }),
  });
  try {
    await assert.rejects(nativeRequest('openDocument'), /bridge unavailable/);
    assert.equal(added, 1);
    assert.equal(removed, 1);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});

test('revoked native recognition stops listening and cannot accept a late model result', async () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  let request = '',
    listeners = 0;
  const add = target.addEventListener.bind(target),
    remove = target.removeEventListener.bind(target);
  target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
    listeners++;
    return add(...args);
  };
  target.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>) => {
    listeners--;
    return remove(...args);
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(target, {
      QuietPaperNative: {
        recognizeInk(id: string) {
          request = id;
        },
      },
    }),
  });
  try {
    const controller = new AbortController();
    const pending = nativeRequest('recognizeInk', ['{}'], controller.signal);
    assert.equal(listeners, 1);
    controller.abort(new Error('authorization revoked'));
    await assert.rejects(pending, /authorization revoked/);
    assert.equal(listeners, 0);
    target.dispatchEvent(
      new CustomEvent('quietpaper-native', {
        detail: { requestId: request, ok: true, text: 'late result' },
      }),
    );
    await assert.rejects(
      nativeRequest('recognizeInk', ['{}'], controller.signal),
      /authorization revoked/,
    );
    assert.equal(listeners, 0);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});
