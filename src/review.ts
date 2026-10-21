/** Local, pluggable scheduler. `adaptive` is a small FSRS-inspired heuristic, not the FSRS model. */
export type ReviewAlgorithm = 'adaptive' | 'fixed' | (string & {});
export type ReviewCard = {
  blockId: string;
  noteId: string;
  modifiedAt: number;
  dueAt: number;
  difficulty: number;
  importance: number;
  subject?: string;
  stability: number;
  reviews: number;
  lapses: number;
  lastReviewedAt?: number;
  initialDifficulty?: number;
  initialImportance?: number;
  history: { at: number; known: boolean; intervalDays: number; algorithm: string }[];
};
export type ReviewSettings = {
  algorithm?: ReviewAlgorithm;
  fixedDays?: number;
  dailyLimit?: number;
  intensity?: number;
  examAt?: number;
  subjectPriority?: Record<string, number>;
};
export type ReviewAlgorithmFunction = (
  card: ReviewCard,
  known: boolean,
  settings: ReviewSettings,
  now: number,
) => { intervalDays: number; stability: number; difficulty: number };
const DAY = 86_400_000;
const algorithms = new Map<string, ReviewAlgorithmFunction>();
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

export function registerReviewAlgorithm(
  id: string,
  algorithm: ReviewAlgorithmFunction,
): () => void {
  if (!id.trim() || ['fixed', 'adaptive'].includes(id)) throw new Error('自定义算法需要唯一名称');
  algorithms.set(id, algorithm);
  return () => {
    algorithms.delete(id);
  };
}

export function createReviewCard(
  blockId: string,
  noteId: string,
  modifiedAt: number,
  options: Partial<Pick<ReviewCard, 'difficulty' | 'importance' | 'subject'>> = {},
): ReviewCard {
  if (!blockId || !noteId || !Number.isFinite(modifiedAt)) throw new Error('无效的知识块复习信息');
  const difficulty = clamp(finite(options.difficulty, 5), 1, 10),
    importance = clamp(finite(options.importance, 3), 1, 5);
  // The modification date is the scheduling baseline; difficult/important material returns sooner.
  const initialDays = clamp((11 - difficulty) / (importance + 2), 0.25, 3);
  return {
    blockId,
    noteId,
    modifiedAt,
    dueAt: modifiedAt + initialDays * DAY,
    difficulty,
    importance,
    initialDifficulty: difficulty,
    initialImportance: importance,
    subject: options.subject,
    stability: initialDays,
    reviews: 0,
    lapses: 0,
    history: [],
  };
}

export function touchReviewCard(card: ReviewCard, modifiedAt: number): ReviewCard {
  if (!Number.isFinite(modifiedAt) || modifiedAt <= card.modifiedAt) return structuredClone(card);
  const fresh = createReviewCard(card.blockId, card.noteId, modifiedAt, card);
  return { ...structuredClone(card), modifiedAt, dueAt: Math.min(card.dueAt, fresh.dueAt) };
}

export function scheduleReview(
  card: ReviewCard,
  known: boolean,
  settings: ReviewSettings = {},
  now = Date.now(),
): ReviewCard {
  if (!Number.isFinite(now) || now < 0) throw new Error('无效复习时间');
  const algorithm = settings.algorithm ?? 'adaptive';
  let next: { intervalDays: number; stability: number; difficulty: number };
  if (algorithm === 'fixed') {
    const days = clamp(finite(settings.fixedDays, 3), 0.04, 3650);
    next = {
      intervalDays: known ? days : Math.min(1, days / 3),
      stability: days,
      difficulty: card.difficulty,
    };
  } else if (algorithm === 'adaptive') {
    const elapsed =
      card.lastReviewedAt === undefined
        ? card.stability
        : Math.max(0, (now - card.lastReviewedAt) / DAY);
    const retrievability = Math.exp(-elapsed / Math.max(0.25, card.stability));
    const difficulty = clamp(card.difficulty + (known ? -0.2 : 0.8), 1, 10);
    const stability = known
      ? Math.max(1, card.stability * (1.6 + (11 - difficulty) / 10 + (1 - retrievability) * 0.6))
      : Math.max(0.25, card.stability * 0.35);
    next = { intervalDays: stability / (1 + (card.importance - 3) * 0.1), stability, difficulty };
  } else {
    const custom = algorithms.get(algorithm);
    if (!custom) throw new Error(`未注册的复习算法：${algorithm}`);
    next = custom(structuredClone(card), known, structuredClone(settings), now);
  }
  if (
    ![next.intervalDays, next.stability, next.difficulty].every(Number.isFinite) ||
    next.intervalDays <= 0 ||
    next.stability <= 0
  )
    throw new Error('复习算法返回无效排期');
  let intervalDays = clamp(
    next.intervalDays / clamp(finite(settings.intensity, 1), 0.25, 4),
    0.04,
    3650,
  );
  if (settings.examAt !== undefined && Number.isFinite(settings.examAt) && settings.examAt > now)
    intervalDays = Math.min(intervalDays, Math.max(0.04, (settings.examAt - now) / DAY / 3));
  return {
    ...structuredClone(card),
    dueAt: now + intervalDays * DAY,
    lastReviewedAt: now,
    difficulty: clamp(next.difficulty, 1, 10),
    stability: next.stability,
    reviews: card.reviews + 1,
    lapses: card.lapses + (known ? 0 : 1),
    history: [...card.history, { at: now, known, intervalDays, algorithm }],
  };
}

export function dueReviews(
  cards: ReviewCard[],
  settings: ReviewSettings = {},
  now = Date.now(),
): ReviewCard[] {
  const dayStart = Math.floor(now / DAY) * DAY;
  const reviewedToday = cards.reduce(
    (count, card) =>
      count +
      (card.history.some((entry) => entry.at >= dayStart && entry.at < dayStart + DAY) ? 1 : 0),
    0,
  );
  const limit = Math.max(
    0,
    Math.floor(clamp(finite(settings.dailyLimit, 20), 0, 1000)) - reviewedToday,
  );
  const score = (card: ReviewCard) =>
    (now - card.dueAt) / DAY +
    card.importance * 0.6 +
    card.difficulty * 0.15 +
    finite(settings.subjectPriority?.[card.subject ?? ''], 0);
  return cards
    .filter((card) => card.dueAt <= now)
    .sort((a, b) => score(b) - score(a) || a.dueAt - b.dueAt || a.blockId.localeCompare(b.blockId))
    .slice(0, limit)
    .map((card) => structuredClone(card));
}

export type ReviewAssessmentEvent = {
  id: string;
  blockId: string;
  noteId: string;
  at: number;
  known: boolean;
  intervalDays: number;
  algorithm: string;
  settings?: ReviewSettings;
  outcome?: { stability: number; difficulty: number };
};
/**
 * Rebuild a card from immutable self-assessments. Stored interval outcomes remain authoritative,
 * so replays do not depend on current preferences or availability of a custom algorithm.
 */
export function projectReviewEvents(
  card: ReviewCard,
  events: ReviewAssessmentEvent[],
  settings: ReviewSettings = {},
): ReviewCard {
  const unique = new Map<string, ReviewAssessmentEvent>();
  const signature = (
    event: Pick<ReviewAssessmentEvent, 'at' | 'known' | 'intervalDays' | 'algorithm'>,
  ) => JSON.stringify([event.at, event.known, event.intervalDays, event.algorithm]);
  for (const event of events) {
    if (event.blockId !== card.blockId || event.noteId !== card.noteId) continue;
    if (
      !event.id ||
      !Number.isFinite(event.at) ||
      event.at < 0 ||
      typeof event.known !== 'boolean' ||
      !Number.isFinite(event.intervalDays) ||
      event.intervalDays <= 0 ||
      !event.algorithm
    )
      throw new Error('无效的复习自评事件');
    const previous = unique.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event))
      throw new Error('复习自评事件身份冲突');
    unique.set(event.id, structuredClone(event));
  }
  if (!unique.size) return structuredClone(card);
  // Preserve older history written before immutable assessment events were introduced.
  const matched = new Map<string, number>();
  for (const event of unique.values())
    matched.set(signature(event), (matched.get(signature(event)) ?? 0) + 1);
  for (const [index, entry] of card.history.entries()) {
    const key = signature(entry),
      remaining = matched.get(key) ?? 0;
    if (remaining) {
      matched.set(key, remaining - 1);
      continue;
    }
    const id = `legacy-history:${index}:${key}`;
    unique.set(id, { ...entry, id, blockId: card.blockId, noteId: card.noteId });
  }
  let projection = createReviewCard(card.blockId, card.noteId, card.modifiedAt, {
    difficulty: card.initialDifficulty ?? card.difficulty,
    importance: card.initialImportance ?? card.importance,
    subject: card.subject,
  });
  projection.importance = card.importance;
  const ordered = [...unique.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const event of ordered) {
    let next: ReviewCard;
    if (['adaptive', 'fixed'].includes(event.algorithm) || algorithms.has(event.algorithm))
      next = scheduleReview(
        projection,
        event.known,
        { ...settings, ...event.settings, algorithm: event.algorithm },
        event.at,
      );
    else
      next = {
        ...projection,
        lastReviewedAt: event.at,
        reviews: projection.reviews + 1,
        lapses: projection.lapses + (event.known ? 0 : 1),
        history: [
          ...projection.history,
          {
            at: event.at,
            known: event.known,
            intervalDays: event.intervalDays,
            algorithm: event.algorithm,
          },
        ],
      };
    next.history[next.history.length - 1] = {
      at: event.at,
      known: event.known,
      intervalDays: event.intervalDays,
      algorithm: event.algorithm,
    };
    next.dueAt = event.at + event.intervalDays * DAY;
    if (event.outcome) {
      if (
        !Number.isFinite(event.outcome.stability) ||
        event.outcome.stability <= 0 ||
        !Number.isFinite(event.outcome.difficulty)
      )
        throw new Error('无效的复习算法状态');
      next.stability = event.outcome.stability;
      next.difficulty = clamp(event.outcome.difficulty, 1, 10);
    }
    projection = next;
  }
  if (card.modifiedAt > ordered[ordered.length - 1].at)
    projection.dueAt = Math.min(
      projection.dueAt,
      createReviewCard(card.blockId, card.noteId, card.modifiedAt, card).dueAt,
    );
  return projection;
}
