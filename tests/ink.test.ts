import test from 'node:test';
import assert from 'node:assert/strict';
import { inkRadius, strokeOutline } from '../src/ink.ts';
import type { Point } from '../src/domain.ts';
const point = (x: number, y: number, pressure = 0.5): Point => ({
  x,
  y,
  pressure,
  tiltX: 12,
  tiltY: -7,
  time: x,
});
test('ink radius retains pen pressure including genuine zero-pressure samples', () => {
  assert.equal(inkRadius(4, 0), 0.8);
  assert.equal(inkRadius(4, 0.5), 2);
  assert.equal(inkRadius(4, 1), 3.2);
});
test('single taps, stationary pressure changes, and an empty stroke have finite outlines', () => {
  assert.equal(strokeOutline([]), '');
  for (const points of [[point(10, 10)], [point(10, 10, 0.2), point(10, 10, 0.9)]]) {
    const path = strokeOutline(points);
    assert.ok(path.includes('a'));
    assert.ok(!/NaN|Infinity/.test(path));
  }
});
test('a path keeps distinct widths for low and high pressure portions without mutating samples', () => {
  const points = [point(0, 0, 0), point(10, 0, 0), point(20, 0, 1), point(30, 0, 1)];
  const before = structuredClone(points),
    path = strokeOutline(points, 4);
  assert.ok(path.includes('A0.8,0.8'));
  assert.ok(path.includes('A2,2'));
  assert.ok(path.includes('A3.2,3.2'));
  assert.deepEqual(points, before);
});
test('large ink rendering generates one compound path string per stroke rather than one element per sample', () => {
  const samples = Array.from({ length: 60 }, (_, i) =>
      point(i * 2, 10 + Math.sin(i / 6) * 20, i / 59),
    ),
    paths = Array.from({ length: 1000 }, () => strokeOutline(samples, 2.4));
  assert.equal(paths.length, 1000);
  assert.equal(
    paths.reduce((sum, path) => sum + (path.match(/Z/g)?.length ?? 0), 0),
    59000,
  );
  assert.ok(paths.every((path) => !path.includes('NaN')));
});
