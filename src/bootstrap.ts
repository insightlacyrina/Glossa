import { NotebookEngine, type Point } from './domain';
export function seedWorkspace(deviceId: string): NotebookEngine {
  const e = new NotebookEngine(undefined, deviceId, 'tablet');
  const folder = e.createFolder('数学', '自然科学');
  e.createFolder('灵感', '日常');
  e.createFolder('阅读', '人文');
  const id = e.createNote('变化，与积累', { template: 'dot' });
  const p = e.getNote(id).pages[0].id;
  e.manageNote(id, { folderId: folder, tags: ['微积分', '示例'] });
  e.addText(id, p, '01  /  CALCULUS', { x: 72, y: 66, width: 650, height: 28 });
  const title = e.addText(id, p, '变化，与积累', { x: 72, y: 119, width: 650, height: 55 });
  const intro = e.addText(id, p, '导数描述一个瞬间，积分收集每个瞬间。', {
    x: 76,
    y: 205,
    width: 650,
    height: 38,
  });
  const formula = e.addText(
    id,
    p,
    'F(b) − F(a) = ∫ₐᵇ f(x) dx',
    { x: 105, y: 291, width: 585, height: 67 },
    'formula',
  );
  const b = e.createBlock(id, '微积分基本定理', [title, intro, formula]);
  e.recognize(id, b, [intro], '导数描述一个瞬间，积分收集每个瞬间。', {
    deterministic: true,
    confidence: 1,
  });
  e.recognize(id, b, [formula], 'F(b) − F(a) = ∫ₐᵇ f(x) dx', {
    kind: 'formula',
    deterministic: true,
    confidence: 1,
  });
  const stroke = (points: [number, number][], color = '#45423e', width = 1.7) =>
    e.addStroke(
      id,
      p,
      points.map(([x, y], i): Point => ({ x, y, pressure: 0.5, tiltX: 0, tiltY: 0, time: i * 16 })),
      { color, width },
    );
  stroke([
    [159, 680],
    [159, 448],
  ]);
  stroke([
    [130, 652],
    [632, 652],
  ]);
  stroke([
    [153, 460],
    [159, 448],
    [166, 459],
  ]);
  stroke([
    [619, 646],
    [632, 652],
    [620, 659],
  ]);
  const curve: [number, number][] = [];
  for (let i = 0; i <= 90; i++) {
    const x = 177 + i * 4.7;
    curve.push([x, 622 - 0.00076 * (x - 152) * (x - 152)]);
  }
  const graph = stroke(curve, '#64755e', 2.8);
  stroke(
    [
      [260, 652],
      [260, 612],
    ],
    '#a69c89',
    1,
  );
  stroke(
    [
      [510, 652],
      [510, 525],
    ],
    '#a69c89',
    1,
  );
  for (let x = 275; x < 510; x += 18)
    stroke(
      [
        [x, 647],
        [x, 628 - 0.00076 * (x - 152) * (x - 152)],
      ],
      '#c9cebd',
      1.6,
    );
  e.addText(id, p, 'a', { x: 250, y: 666, width: 30, height: 35 }, 'formula');
  e.addText(id, p, 'b', { x: 500, y: 666, width: 30, height: 35 }, 'formula');
  e.addText(id, p, 'f(x)', { x: 595, y: 448, width: 100, height: 35 }, 'formula');
  const g = e.createBlock(id, '曲线下的面积', [graph]);
  e.recognize(id, g, [graph], '曲线 f(x) 与区间 [a, b] 围成的面积。', {
    kind: 'reference',
    confirmed: true,
    confidence: 1,
  });
  e.linkBlocks(id, b, g);
  const last = e.addText(id, p, '把很小的变化相加，便看见整体。', {
    x: 77,
    y: 804,
    width: 645,
    height: 45,
  });
  const l = e.createBlock(id, '从局部到整体', [last]);
  e.recognize(id, l, [last], '把很小的变化相加，便看见整体。', {
    deterministic: true,
    confidence: 1,
  });
  // The bundled example already has an authored structure; it is not a claimed OCR result.
  for (const object of e.getNote(id).pages.flatMap((p) => p.objects))
    e.setSetting('processed:' + object.id, object.version);
  return e;
}
