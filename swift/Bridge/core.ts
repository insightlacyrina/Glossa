import { NotebookEngine } from '../../src/domain';
import { exportReadingHtml, exportStructuredMarkdown } from '../../src/export';
import {
  createReviewCard,
  touchReviewCard,
  projectReviewEvents,
  dueReviews,
  scheduleReview,
  type ReviewCard,
  type ReviewAssessmentEvent,
  type ReviewSettings,
} from '../../src/review';
import { blockContentModifiedAt } from '../../src/workspaceSafety';

// JavaScriptCore supplies UUID and UTF-8 through narrow, synchronous Swift functions.
declare const nativeUUID: () => string;
declare const nativeUTF8: (value: string) => number[];
(globalThis as any).crypto = { randomUUID: () => nativeUUID() };
(globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
(globalThis as any).TextEncoder = class {
  encode(value: string) {
    return nativeUTF8(value);
  }
};

let engine: NotebookEngine;
let deviceID: string;
const serialize = (value: unknown) => JSON.stringify(value === undefined ? null : value);
const required = (args: Record<string, any>, key: string): string => {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`缺少参数 ${key}`);
  return args[key];
};
function settings(): ReviewSettings {
  return (engine.state.settings.reviewSettings ?? {
    dailyLimit: 20,
    algorithm: 'adaptive',
  }) as ReviewSettings;
}
function cards(): ReviewCard[] {
  const assessments = Object.entries(engine.state.settings)
    .filter(([key, value]) => key.startsWith('review-event:') && value)
    .map(([id, value]) => ({ id, ...(value as Omit<ReviewAssessmentEvent, 'id'>) }))
    .map((assessment) => ({ ...assessment, blockId: engine.resolveBlockId(assessment.blockId) }));
  return engine.state.notes.flatMap((note) =>
    note.blocks.map((block) => {
      const at = blockContentModifiedAt(engine.project, engine, note.id, block.id);
      const old = engine.state.settings[`review:${block.id}`] as ReviewCard | undefined;
      const card = old ? touchReviewCard(old, at) : createReviewCard(block.id, note.id, at);
      return projectReviewEvents(card, assessments, settings());
    }),
  );
}
function run(action: string, args: Record<string, any>): unknown {
  switch (action) {
    case 'editRanges': {
      const noteID = required(args, 'noteID');
      const segmentID = required(args, 'segmentID');
      const segment = engine
        .getNote(noteID)
        .blocks.flatMap((block) => block.segments)
        .find((seg) => seg.id === segmentID && !seg.deleted);
      if (!segment || typeof args.expectedText !== 'string' || segment.text !== args.expectedText)
        throw new Error('段落已在编辑期间改变。输入已保留，请重新核对最新内容。');
      const visible = segment.chars.filter((character) => !character.deleted);
      if (
        !Array.isArray(args.expectedCharacters) ||
        args.expectedCharacters.length !== visible.length ||
        visible.some((character, index) => {
          const expected = args.expectedCharacters[index];
          return (
            !expected ||
            expected.id !== character.id ||
            expected.version !== character.version ||
            expected.value !== character.value
          );
        })
      )
        throw new Error('段落字符身份已在编辑期间改变。输入已保留，请重新核对最新内容。');
      if (!Array.isArray(args.edits)) throw new Error('缺少实际编辑范围');
      if (typeof args.expectedResult !== 'string')
        throw new Error('缺少编辑结果校验，输入已保留。');
      for (const edit of args.edits) run('editRange', { noteID, segmentID, ...edit });
      const result = engine
        .getNote(noteID)
        .blocks.flatMap((block) => block.segments)
        .find((seg) => seg.id === segmentID && !seg.deleted);
      if (!result || result.text !== args.expectedResult)
        throw new Error('部分输入未能匹配实际编辑范围。输入已保留，请重新核对后保存。');
      return null;
    }
    case 'editRange': {
      const note = engine.getNote(required(args, 'noteID'));
      const segment = note.blocks
        .flatMap((block) => block.segments)
        .find((seg) => seg.id === args.segmentID && !seg.deleted);
      if (!segment) throw new Error('段落已不存在。输入已保留。');
      if (typeof args.expectedText !== 'string' || segment.text !== args.expectedText)
        throw new Error('段落已在编辑期间改变。输入已保留，请重新核对最新内容。');
      return engine.editRange(note.id, segment.id, args.start, args.end, String(args.text ?? ''));
    }
    case 'manageNote': {
      const changes: { title?: string; folderId?: string | null; tags?: string[] } = {};
      if ('title' in args) changes.title = String(args.title);
      if ('folderId' in args) changes.folderId = args.folderId;
      if ('tags' in args) changes.tags = args.tags;
      engine.manageNote(required(args, 'noteID'), changes);
      return null;
    }
    case 'createFolder':
      return engine.createFolder(required(args, 'name'), args.subject);
    case 'review': {
      const card = cards().find((card) => card.blockId === required(args, 'blockID'));
      if (!card) throw new Error('知识块已不存在');
      const known = args.known ?? args.rating;
      if (typeof known !== 'boolean') throw new Error('自评应为会了或还不会');
      const preference = settings();
      const next = scheduleReview(card, known, preference, args.now ?? Date.now());
      engine.setSetting(`review:${card.blockId}`, next);
      engine.setSetting(`review-event:${crypto.randomUUID()}`, {
        ...next.history.at(-1),
        blockId: card.blockId,
        noteId: card.noteId,
        settings: preference,
        outcome: { stability: next.stability, difficulty: next.difficulty },
      });
      return next;
    }
    case 'resolveConflict':
      engine.resolveConflict(required(args, 'id'), args.choice);
      return null;
    case 'readingHTML':
      return exportReadingHtml(engine.getNote(required(args, 'noteID')));
    case 'markdown':
      return exportStructuredMarkdown(engine.getNote(required(args, 'noteID')));
    case 'correspondence':
      return engine.findCorrespondence(required(args, 'noteID'), required(args, 'segmentID'));
    case 'setReviewSettings':
      engine.setSetting('reviewSettings', args.settings);
      return null;
    // Deliberately call the same permission checks as the Android/browser kernel.
    case 'createNote':
      return engine.createNote(args.title);
    case 'addPage':
      return engine.addPage(required(args, 'noteID'));
    case 'createBlock':
      return engine.createBlock(required(args, 'noteID'), args.title);
    default:
      throw new Error(`未支持的原生操作 ${action}`);
  }
}
(globalThis as any).GlossaCore = {
  initialize(id: string) {
    deviceID = id;
    engine = new NotebookEngine(undefined, id, 'mac');
  },
  load(json: string) {
    engine = new NotebookEngine(NotebookEngine.importProject(json), deviceID, 'mac');
  },
  project() {
    return engine.exportProject();
  },
  operations() {
    return serialize(engine.project.operations);
  },
  projectID() {
    return engine.project.id;
  },
  snapshot() {
    const state = engine.state;
    const reviewCards = cards();
    const notes = state.notes.map((note) => ({
      ...note,
      pages: note.pages.map((page) => {
        const active = page.objects.filter((object) => !object.deleted);
        const replaced = new Set(
          active
            .filter((object) => object.revisionId)
            .flatMap((object) => object.replacesObjectIds ?? []),
        );
        return { ...page, objects: active.filter((object) => !replaced.has(object.id)) };
      }),
    }));
    return serialize({
      ...state,
      notes,
      projectID: engine.project.id,
      operationCount: engine.project.operations.length,
      reviewCards,
      dueBlockIDs: dueReviews(reviewCards, settings()).map((card) => card.blockId),
      nativeSourcesJSON: serialize(
        Object.entries(state.settings)
          .filter(([key]) => key.startsWith('source:'))
          .map(([, value]) => value),
      ),
    });
  },
  merge(json: string) {
    engine.merge({ ...engine.project, operations: JSON.parse(json) });
  },
  invoke(action: string, json: string) {
    const before = engine.project;
    try {
      return serialize(run(action, JSON.parse(json)));
    } catch (error) {
      engine = new NotebookEngine(before, deviceID, 'mac');
      throw error;
    }
  },
};
