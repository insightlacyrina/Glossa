import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Paper } from '../src/Paper';
import type { Note, Page, PaperObject, Point } from '../src/domain';
const objects: PaperObject[] = Array.from({ length: 1000 }, (_, i) => {
  const x = 40 + (i % 25) * 28,
    y = 110 + Math.floor(i / 25) * 20;
  const points: Point[] = Array.from({ length: 60 }, (_, j) => ({
    x: x + j * 0.35,
    y: y + Math.sin(j / 8) * 5,
    pressure: j / 59,
    tiltX: 12,
    tiltY: -5,
    time: j,
  }));
  return {
    id: `ink:${i}`,
    pageId: 'performance-page',
    kind: 'stroke',
    layerId: 'ink',
    bounds: { x, y: y - 5, width: 21, height: 10 },
    points,
    color: '#39353b',
    width: 2.4,
    version: `version:${i}`,
  };
});
const initial: Page = {
  id: 'performance-page',
  size: 'A4',
  orientation: 'portrait',
  template: 'dot',
  width: 794,
  height: 1123,
  objects,
};
const note: Note = {
  id: 'performance-note',
  title: '手写性能验证',
  pages: [initial],
  blocks: [],
  folderId: null,
  tags: [],
  createdAt: 0,
  modifiedAt: 0,
};
const started = performance.now();
function Harness() {
  const [page, setPage] = useState(initial),
    [committed, setCommitted] = useState(0);
  return (
    <>
      <output id="committed">{committed}</output>
      <Paper
        note={note}
        page={page}
        tool="pen"
        color="#39353b"
        width={2.4}
        layer="ink"
        editable
        selected={[]}
        highlighted={[]}
        onSelect={() => {}}
        onDraft={() => {}}
        onStroke={(points) => {
          setCommitted((c) => c + 1);
          setPage((old) => ({
            ...old,
            objects: [
              ...old.objects,
              {
                id: 'new:' + old.objects.length,
                pageId: old.id,
                kind: 'stroke',
                layerId: 'ink',
                points,
                bounds: { x: 0, y: 0, width: 30, height: 30 },
                width: 2.4,
                version: 'new',
              },
            ],
          }));
        }}
        onErase={() => {}}
        onMove={() => {}}
        onInsert={() => {}}
        onContext={() => {}}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    (window as any).inkPerformance = {
      renderMs: performance.now() - started,
      strokeCount: objects.length,
      sampleCount: objects.reduce((n, o) => n + o.points!.length, 0),
    };
  }),
);
