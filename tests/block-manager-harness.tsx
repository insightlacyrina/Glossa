import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookEngine } from '../src/domain';
import { BlockManager } from '../src/BlockManager';

function seeded() {
  const e = new NotebookEngine(undefined, 'manager-tablet', 'tablet');
  const noteId = e.createNote('结构与纸张'),
    pageId = e.getNote(noteId).pages[0].id,
    page2 = e.addPage(noteId);
  const first = e.addText(noteId, pageId, '先观察变化', { x: 60, y: 80, width: 350, height: 45 });
  const equation = e.addText(
    noteId,
    page2,
    'a+b=c',
    { x: 75, y: 100, width: 350, height: 50 },
    'formula',
  );
  const conclusion = e.addText(noteId, page2, '再看整体关系', {
    x: 75,
    y: 210,
    width: 350,
    height: 45,
  });
  const block = e.createBlock(noteId, '基础关系', [first, equation, conclusion]);
  const firstSegment = e.recognize(noteId, block, [first], '先观察变化', { deterministic: true });
  const equationSegment = e.recognize(noteId, block, [equation], 'a+b=c', {
    deterministic: true,
    kind: 'formula',
  });
  const lastSegment = e.recognize(noteId, block, [conclusion], '再看整体关系', {
    deterministic: true,
  });
  const other = e.addText(noteId, pageId, '图形记录', { x: 80, y: 340, width: 300, height: 50 });
  const otherBlock = e.createBlock(noteId, '图形观察', [other]);
  const otherSegment = e.recognize(noteId, otherBlock, [other], '图形记录', {
    deterministic: true,
  });
  const secondNote = e.createNote('另一本笔记'),
    secondPage = e.getNote(secondNote).pages[0].id;
  const targetObject = e.addText(secondNote, secondPage, '跨笔记关系', {
    x: 50,
    y: 100,
    width: 300,
    height: 50,
  });
  const targetBlock = e.createBlock(secondNote, '远方知识', [targetObject]);
  e.recognize(secondNote, targetBlock, [targetObject], '跨笔记关系', { deterministic: true });
  e.linkBlocks(noteId, otherBlock, targetBlock);
  const role = new URLSearchParams(location.search).get('role');
  const engine =
    role === 'phone' || role === 'mac' ? new NotebookEngine(e.project, 'limited-client', role) : e;
  return {
    engine,
    noteId,
    pageId,
    block,
    equation,
    equationSegment,
    firstSegment,
    lastSegment,
    otherBlock,
    otherSegment,
    targetBlock,
  };
}
function Harness() {
  const [fixture] = useState(seeded),
    [, redraw] = useState(0),
    [open, setOpen] = useState(true);
  const engine = fixture.engine;
  (window as any).blockManagerHarness = {
    ids: fixture,
    snapshot: () =>
      structuredClone({ notes: engine.state.notes, events: engine.project.operations }),
    changeSource: () => {
      engine.editRange(fixture.noteId, fixture.equationSegment, 0, 1, 'x');
      redraw((value) => value + 1);
    },
    moveSource: () => {
      const object = engine
        .getNote(fixture.noteId)
        .pages.flatMap((page) => page.objects)
        .find((object) => object.id === fixture.equation)!;
      engine.updateObject(fixture.noteId, object.id, {
        bounds: { ...object.bounds, x: object.bounds.x + 12 },
      });
      redraw((value) => value + 1);
    },
    unrelatedInk: () => {
      engine.addStroke(fixture.noteId, fixture.pageId, [
        { x: 500, y: 500, pressure: 0.7, tiltX: 12, tiltY: -7, time: 30 },
        { x: 510, y: 510, pressure: 0.6, tiltX: 10, tiltY: -5, time: 40 },
      ]);
      redraw((value) => value + 1);
    },
  };
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        管理知识块
      </button>
      {open && (
        <BlockManager
          engine={engine}
          note={engine.getNote(fixture.noteId)}
          onClose={() => setOpen(false)}
          onChange={(change) => {
            try {
              change(engine);
              redraw((value) => value + 1);
              return true;
            } catch {
              return false;
            }
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
