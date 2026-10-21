import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewCard,
  dueReviews,
  projectReviewEvents,
  registerReviewAlgorithm,
  scheduleReview,
  touchReviewCard,
} from '../src/review.ts';
const now = Date.UTC(2026, 9, 20);

test('review cards use block identity and last content modification, difficulty and importance', () => {
  const easy = createReviewCard('easy', 'note', now, { difficulty: 2, importance: 1 });
  const hard = createReviewCard('hard', 'note', now, { difficulty: 9, importance: 5 });
  assert.equal(hard.modifiedAt, now);
  assert.ok(hard.dueAt < easy.dueAt);
  assert.equal(hard.history.length, 0);
});

test('local self assessment completes a review loop without AI', () => {
  const original = createReviewCard('block', 'note', now);
  const known = scheduleReview(original, true, {}, now + 86_400_000);
  const unknown = scheduleReview(original, false, {}, now + 86_400_000);
  assert.equal(known.reviews, 1);
  assert.equal(unknown.lapses, 1);
  assert.ok(known.dueAt > unknown.dueAt);
  assert.deepEqual(
    known.history.map((e) => e.known),
    [true],
  );
  assert.equal(original.reviews, 0);
});

test('fixed interval, exam target and intensity are operational', () => {
  const card = createReviewCard('block', 'note', now);
  const fixed = scheduleReview(card, true, { algorithm: 'fixed', fixedDays: 6 }, now);
  assert.equal(fixed.dueAt, now + 6 * 86_400_000);
  const intensive = scheduleReview(
    card,
    true,
    { algorithm: 'fixed', fixedDays: 6, intensity: 2 },
    now,
  );
  assert.equal(intensive.dueAt, now + 3 * 86_400_000);
  const exam = scheduleReview(
    card,
    true,
    { algorithm: 'fixed', fixedDays: 6, examAt: now + 3 * 86_400_000 },
    now,
  );
  assert.equal(exam.dueAt, now + 86_400_000);
});

test('due queue respects burden cap and subject priority and is deterministic', () => {
  const math = {
    ...createReviewCard('a', 'note', now - 7 * 86_400_000, { subject: 'math' }),
    dueAt: now - 1,
  };
  const chem = {
    ...createReviewCard('b', 'note', now - 7 * 86_400_000, { subject: 'chem' }),
    dueAt: now - 1,
  };
  assert.equal(
    dueReviews([math, chem], { dailyLimit: 1, subjectPriority: { chem: 10 } }, now)[0].blockId,
    'b',
  );
  assert.equal(dueReviews([math, chem], { dailyLimit: 0 }, now).length, 0);
  assert.equal(dueReviews([math, chem], { dailyLimit: 20 }, now - 1000).length, 0);
});

test('custom algorithm extension validates outputs and cannot replace built-ins', () => {
  const unregister = registerReviewAlgorithm('custom', () => ({
    intervalDays: 12,
    stability: 9,
    difficulty: 4,
  }));
  const card = createReviewCard('b', 'n', now);
  assert.equal(
    scheduleReview(card, true, { algorithm: 'custom' }, now).dueAt,
    now + 12 * 86_400_000,
  );
  unregister();
  assert.throws(() => scheduleReview(card, true, { algorithm: 'custom' }, now), /未注册/);
  assert.throws(
    () =>
      registerReviewAlgorithm('fixed', () => ({ intervalDays: 1, stability: 1, difficulty: 1 })),
    /唯一/,
  );
  registerReviewAlgorithm('bad', () => ({ intervalDays: NaN, stability: 1, difficulty: 1 }));
  assert.throws(() => scheduleReview(card, true, { algorithm: 'bad' }, now), /无效/);
});

test('new content modification is incorporated without deleting review history', () => {
  const card = scheduleReview(
    createReviewCard('b', 'n', now),
    true,
    { algorithm: 'fixed', fixedDays: 30 },
    now + 1,
  );
  const updated = touchReviewCard(card, now + 86_400_000);
  assert.equal(updated.history.length, 1);
  assert.equal(updated.modifiedAt, now + 86_400_000);
  assert.ok(updated.dueAt < card.dueAt);
  assert.deepEqual(touchReviewCard(card, now - 1), card);
});

test('daily burden subtracts blocks already reviewed today', () => {
  const reviewed = scheduleReview(
    createReviewCard('done', 'note', now - 5 * 86_400_000),
    true,
    {},
    now + 1,
  );
  const waiting = { ...createReviewCard('waiting', 'note', now - 5 * 86_400_000), dueAt: now - 1 };
  assert.equal(dueReviews([reviewed, waiting], { dailyLimit: 1 }, now + 1000).length, 0);
  assert.equal(dueReviews([reviewed, waiting], { dailyLimit: 2 }, now + 1000).length, 1);
});

test('immutable simultaneous assessments rebuild a deterministic queue without losing either user judgement', () => {
  const card = createReviewCard('block', 'note', now);
  const a = {
    id: 'phone-a',
    blockId: 'block',
    noteId: 'note',
    at: now + 1000,
    known: true,
    intervalDays: 5,
    algorithm: 'fixed',
    outcome: { stability: 5, difficulty: 4 },
  };
  const b = {
    id: 'tablet-b',
    blockId: 'block',
    noteId: 'note',
    at: now + 1000,
    known: false,
    intervalDays: 0.5,
    algorithm: 'fixed',
    outcome: { stability: 1, difficulty: 6 },
  };
  const first = projectReviewEvents(card, [a, b, a]);
  const reverse = projectReviewEvents(card, [b, a]);
  assert.deepEqual(first, reverse);
  assert.equal(first.reviews, 2);
  assert.equal(first.lapses, 1);
  assert.equal(first.dueAt, b.at + 0.5 * 86_400_000);
  assert.equal(first.difficulty, 6);
  assert.equal(first.history.length, 2);
});

test('review projection preserves legacy history and stored custom intervals without requiring that algorithm plugin', () => {
  const legacy = scheduleReview(
    createReviewCard('block', 'note', now),
    true,
    { algorithm: 'fixed', fixedDays: 3 },
    now + 1,
  );
  const event = {
    id: 'new',
    blockId: 'block',
    noteId: 'note',
    at: now + 1000,
    known: true,
    intervalDays: 11,
    algorithm: 'unavailable-custom',
    outcome: { stability: 9, difficulty: 3 },
  };
  const result = projectReviewEvents(legacy, [event]);
  assert.equal(result.history.length, 2);
  assert.equal(result.dueAt, event.at + 11 * 86_400_000);
  assert.equal(result.stability, 9);
  assert.deepEqual(projectReviewEvents(result, [event]), result);
  assert.throws(
    () => projectReviewEvents(legacy, [event, { ...event, intervalDays: 4 }]),
    /身份冲突/,
  );
});
