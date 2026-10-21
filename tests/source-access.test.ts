import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeLink, editLinkedPaper, openNative } from '../src/formats.ts';
import { recordSourceFailure } from '../src/source-coordinator.ts';

function offlineLink() {
  const source = openNative('provider.md', '# 原稿\n\n$E=mc^2$\n');
  const link = editLinkedPaper(createNativeLink(source, source.objects.at(-1)!.id), '$E=mc^3$');
  return {
    ...link,
    offlineTimeoutMs: 50,
    lastSourceContact: 100,
    unavailableSince: 200,
    status: 'unavailable' as const,
  };
}

test('verified provider access clears stale offline time even when decoding or local persistence fails', () => {
  const before = offlineLink();
  const next = recordSourceFailure(before, { unavailable: false, sourceReachable: true }, 1000);
  assert.equal(next.mode, 'linked');
  assert.equal(next.status, 'pending');
  assert.equal(next.unavailableSince, undefined);
  assert.equal(next.lastSourceContact, 1000);
  assert.equal(before.unavailableSince, 200);
  assert.deepEqual(next.queued, before.queued);
  assert.equal(next.paperContent, before.paperContent);
  const newlyOffline = recordSourceFailure(next, { unavailable: true }, 1100);
  assert.equal(newlyOffline.mode, 'linked');
  assert.equal(newlyOffline.unavailableSince, 1100);
  assert.equal(recordSourceFailure(newlyOffline, { unavailable: true }, 1151).mode, 'frozen');
});

test('unknown and local pre-read errors cannot invent successful source contact', () => {
  const before = offlineLink();
  for (const reply of [{}, { unavailable: false }]) {
    const next = recordSourceFailure(before, reply, 1000);
    assert.equal(next.lastSourceContact, 100);
    assert.equal(next.unavailableSince, 200);
    assert.deepEqual(next.queued, before.queued);
  }
  assert.equal(
    recordSourceFailure(before, { unavailable: true, sourceReachable: true }, 1000).mode,
    'frozen',
  );
});

test('source reachability preserves unresolved object identity, conflict state and frozen copies', () => {
  const before = offlineLink();
  for (const status of ['missing', 'conflict'] as const) {
    const next = recordSourceFailure({ ...before, status }, { sourceReachable: true }, 1000);
    assert.equal(next.status, status);
    assert.equal(next.unavailableSince, undefined);
  }
  for (const mode of ['frozen', 'detached'] as const) {
    const retained = { ...before, mode, status: mode };
    assert.deepEqual(recordSourceFailure(retained, { sourceReachable: true }, 1000), retained);
  }
});

test('a successful read survives a later journal failure, while a later provider failure starts a fresh deadline', () => {
  const before = offlineLink();
  const localFailure = recordSourceFailure(before, {}, 1050, 1000);
  assert.equal(localFailure.lastSourceContact, 1000);
  assert.equal(localFailure.unavailableSince, undefined);
  assert.deepEqual(localFailure.queued, before.queued);
  const providerFailure = recordSourceFailure(before, { unavailable: true }, 1050, 1000);
  assert.equal(providerFailure.lastSourceContact, 1000);
  assert.equal(providerFailure.unavailableSince, 1050);
  assert.equal(providerFailure.mode, 'linked');
  assert.equal(recordSourceFailure(providerFailure, { unavailable: true }, 1101).mode, 'frozen');
});
