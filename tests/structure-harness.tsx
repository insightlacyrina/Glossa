// Browser-only integration fixture served by Vite; never imported by the application.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookEngine } from '../src/domain';
import { Structure } from '../src/Structure';
const seed = new NotebookEngine(undefined, 'fixture-tablet');
const noteId = seed.createNote('字符身份浏览器验收');
const pageId = seed.getNote(noteId).pages[0].id;
const objectId = seed.addText(
  noteId,
  pageId,
  '😀xx+x',
  { x: 40, y: 40, width: 400, height: 50 },
  'formula',
);
const blockId = seed.createBlock(noteId, '重复符号', [objectId]);
const segmentId = seed.recognize(noteId, blockId, [objectId], '😀xx+x', {
  kind: 'formula',
  deterministic: true,
});
const strokeId = seed.addStroke(noteId, pageId, [
  { x: 30, y: 100, pressure: 0.6, tiltX: 1, tiltY: 2, time: 1 },
  { x: 200, y: 150, pressure: 0.7, tiltX: 2, tiltY: 3, time: 2 },
]);
seed.recognize(noteId, blockId, [strokeId], '图形的完整原始笔迹', {
  kind: 'reference',
  confirmed: true,
});
const engine = new NotebookEngine(seed.project, 'fixture-phone', 'phone');
let refresh = () => {};
const harness = {
  engine,
  noteId,
  segmentId,
  lastJump: [] as string[],
  remote(start: number, end: number, text: string) {
    engine.editRange(noteId, segmentId, start, end, text);
    refresh();
  },
  snapshot() {
    return {
      text: engine.getNote(noteId).blocks[0].segments[0].text,
      conflicts: engine.state.conflicts,
      corrections: engine.state.corrections,
      role: engine.role,
      operations: engine.project.operations,
    };
  },
};
Object.assign(window, { structureHarness: harness });
function Harness() {
  const [, redraw] = useState(0);
  refresh = () => redraw((v) => v + 1);
  return (
    <Structure
      engine={engine}
      note={engine.getNote(noteId)}
      editable
      onChange={(action) => {
        action(engine);
        refresh();
      }}
      onJump={(ids) => {
        harness.lastJump = ids;
      }}
      onProof={() => {}}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
