import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { backup } from 'node:sqlite';
import { createSyncServer } from '../server/app.mjs';
import { NotebookEngine, type Operation, type Project } from '../src/domain.ts';
import { syncOperations, type SyncConfig, type SyncOperation } from '../src/sync.ts';
import { createReviewCard, scheduleReview, type ReviewCard } from '../src/review.ts';
import { createNativeLink, openNative } from '../src/formats.ts';

function operations(engine: NotebookEngine): SyncOperation[] {
  return engine.project.operations as unknown as SyncOperation[];
}
function receive(engine: NotebookEngine, ops: SyncOperation[]) {
  engine.merge({ ...engine.project, operations: ops as unknown as Operation[] });
}

for (const mode of ['plain', 'e2ee'] as const) {
  test(`domain → ${mode} HTTP → phone/Mac symbols → tablet A revision → backup restoration`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'quiet-paper-e2e-'));
    const app = createSyncServer({
      dataDir: directory,
      token: 'integration-test-token-at-least-24-characters',
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    let restoredApp: ReturnType<typeof createSyncServer> | undefined;
    t.after(async () => {
      if (restoredApp) await restoredApp.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });
    const address = app.server.address() as { port: number };
    const tablet = new NotebookEngine(undefined, 'android-tablet', 'tablet');
    const noteId = tablet.createNote('符号协作与恢复');
    const pageId = tablet.getNote(noteId).pages[0].id;
    const objectId = tablet.addText(
      noteId,
      pageId,
      'a+b=c',
      { x: 80, y: 120, width: 300, height: 48 },
      'formula',
    );
    const blockId = tablet.createBlock(noteId, '等式', [objectId]);
    const segmentId = tablet.recognize(noteId, blockId, [objectId], 'a+b=c', {
      kind: 'formula',
      deterministic: true,
      confidence: 1,
      charMap: Array.from('a+b=c', (_, index) => ({ index, objectIds: [objectId] })),
    });
    tablet.setSetting('review-settings', { algorithm: 'fixed', fixedDays: 3, dailyLimit: 15 });
    const initialCard = createReviewCard(blockId, noteId, tablet.getNote(noteId).modifiedAt, {
      subject: '数学',
    });
    const reviewed = scheduleReview(
      initialCard,
      true,
      { algorithm: 'fixed', fixedDays: 3 },
      initialCard.dueAt,
    );
    tablet.setSetting(`review:${blockId}`, reviewed);
    const source = openNative('proof.md', '# 证明\n\na+b=c\n');
    const link = createNativeLink(source, source.objects.at(-1)!.id);
    tablet.setSetting(`native-source:${source.id}`, source);
    tablet.setSetting(`native-link:${link.id}`, link);
    const config: SyncConfig = {
      url: `http://127.0.0.1:${address.port}`,
      token: 'integration-test-token-at-least-24-characters',
      projectId: tablet.project.id,
      mode,
      ...(mode === 'e2ee' ? { passphrase: 'integration-long-encryption-passphrase' } : {}),
    };
    const baseline = await syncOperations(config, operations(tablet));
    // A round trip must not mistake JSON property ordering for an identity collision.
    receive(tablet, baseline.operations);
    assert.equal(tablet.validateMappings()[0].valid, true);
    const baselineCharacters = tablet
      .getNote(noteId)
      .blocks[0].segments[0].chars.map((char) => char.id);
    // A text object has an exact object link; no glyph geometry is invented for its characters.
    assert.equal(tablet.getNote(noteId).blocks[0].segments[0].source.precision, 'object');
    const empty: Project = {
      schemaVersion: 1,
      id: tablet.project.id,
      metadata: {},
      operations: [],
    };
    const phone = new NotebookEngine(empty, 'android-phone', 'phone');
    const mac = new NotebookEngine(empty, 'mac-client', 'mac');
    receive(phone, baseline.operations);
    receive(mac, baseline.operations);
    assert.throws(() => phone.createNote('不允许的新笔记'), /平板/);
    assert.throws(() => mac.createBlock(noteId, '不允许的新块'), /平板/);
    const phoneRevision = phone.editSegment(noteId, segmentId, 'x+b=c')!;
    mac.editSegment(noteId, segmentId, 'a+b=z');
    const phoneUpload = await syncOperations(config, operations(phone), baseline.cursor);
    receive(phone, phoneUpload.operations);
    const macUpload = await syncOperations(config, operations(mac), baseline.cursor);
    receive(mac, macUpload.operations);
    const tabletPull = await syncOperations(config, operations(tablet), baseline.cursor);
    receive(tablet, tabletPull.operations);
    const segment = tablet.getNote(noteId).blocks[0].segments[0];
    assert.equal(segment.text, 'x+b=z');
    assert.equal(tablet.state.conflicts.length, 0);
    assert.equal(segment.source.precision, 'object');
    assert.deepEqual(
      segment.chars.map((char) => char.id),
      baselineCharacters,
    );
    assert.ok(tablet.findCorrespondence(noteId, objectId).segmentIds.includes(segmentId));
    const revisions = tablet.state.corrections;
    assert.equal(revisions.length, 2);
    const active = tablet
      .getNote(noteId)
      .pages[0].objects.filter((object) => object.revisionId && !object.deleted);
    assert.equal(active.length, 1);
    assert.equal(active[0].text, 'x+b=z');
    assert.equal(active[0].layerId.startsWith('revision:'), true);
    assert.equal(revisions.at(-1)!.mode, 'printed');
    const newStroke = tablet.addStroke(noteId, pageId, [
      { x: 11, y: 22, pressure: 0.4, tiltX: -12, tiltY: 27, time: 10 },
      { x: 12, y: 24, pressure: 0.7, tiltX: -11, tiltY: 25, time: 20 },
    ]);
    tablet.undoRevision(phoneRevision);
    assert.equal(tablet.getNote(noteId).blocks[0].segments[0].text, 'a+b=z');
    assert.ok(
      tablet
        .getNote(noteId)
        .pages[0].objects.some((object) => object.id === newStroke && !object.deleted),
    );
    const extraObject = tablet.addText(noteId, pageId, '补充过程', {
      x: 80,
      y: 280,
      width: 300,
      height: 48,
    });
    const extraSegment = tablet.recognize(noteId, blockId, [extraObject], '补充过程', {
      deterministic: true,
    });
    const pagesBeforeStructure = structuredClone(tablet.getNote(noteId).pages);
    const splitBlockId = tablet.splitBlock(noteId, blockId, [extraSegment], '补充知识');
    tablet.mergeBlocks(noteId, [blockId, splitBlockId], '等式与过程');
    assert.equal(tablet.resolveBlockId(splitBlockId), blockId);
    assert.deepEqual(tablet.getNote(noteId).pages, pagesBeforeStructure);
    await syncOperations(config, operations(tablet), tabletPull.cursor);
    const snapshot = join(directory, 'restored');
    await mkdir(snapshot);
    await backup(app.db, join(snapshot, 'quiet-paper.sqlite'));
    restoredApp = createSyncServer({ dataDir: snapshot, token: config.token });
    restoredApp.server.listen(0, '127.0.0.1');
    await once(restoredApp.server, 'listening');
    const restoredPort = (restoredApp.server.address() as { port: number }).port;
    const recovered = new NotebookEngine(empty, 'recovered-tablet', 'tablet');
    receive(
      recovered,
      (await syncOperations({ ...config, url: `http://127.0.0.1:${restoredPort}` }, [], 0))
        .operations,
    );
    assert.deepEqual(recovered.getNote(noteId), tablet.getNote(noteId));
    assert.deepEqual(recovered.state.blockAliases, tablet.state.blockAliases);
    assert.deepEqual(recovered.state.blockArchive, tablet.state.blockArchive);
    assert.equal(recovered.resolveBlockId(splitBlockId), blockId);
    assert.deepEqual(recovered.state.settings, tablet.state.settings);
    assert.equal(
      (recovered.state.settings[`review:${blockId}`] as ReviewCard).history[0].known,
      true,
    );
    assert.deepEqual(recovered.state.settings[`native-source:${source.id}`], source);
    assert.deepEqual(recovered.state.settings[`native-link:${link.id}`], link);
    const imported = new NotebookEngine(
      NotebookEngine.importProject(recovered.exportProject()),
      'imported-tablet',
      'tablet',
    );
    assert.deepEqual(imported.state, recovered.state);
  });
}
