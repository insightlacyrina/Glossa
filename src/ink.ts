import type { Point } from './domain';

/** Visual pressure curve only. Original pressure/tilt samples stay untouched in A. */
export function inkRadius(width: number, pressure: number): number {
  const bounded = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
  return Math.max(0.05, (width * (0.4 + bounded * 1.2)) / 2);
}
const n = (value: number) => String(Math.round(value * 1000) / 1000);
function disc(x: number, y: number, r: number): string {
  return `M${n(x - r)},${n(y)}a${n(r)},${n(r)} 0 1 0 ${n(r * 2)},0a${n(r)},${n(r)} 0 1 0 ${n(-r * 2)},0Z`;
}
/**
 * One SVG path for an entire stroke. Each subpath is the original round-ended segment
 * with its own pressure width; SVG's nonzero fill unions overlaps in one paint pass.
 * This avoids one DOM element per pen sample without quantizing pressure or flattening A.
 * Rendering coordinates round to 0.001 paper units; saved samples retain full precision.
 */
export function strokeOutline(points: readonly Point[], width = 2): string {
  if (!points.length) return '';
  if (points.length === 1)
    return disc(points[0].x, points[0].y, inkRadius(width, points[0].pressure));
  const path: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      dx = b.x - a.x,
      dy = b.y - a.y,
      length = Math.hypot(dx, dy);
    const radius = inkRadius(width, (a.pressure + b.pressure) / 2);
    if (length < 1e-9) {
      path.push(disc(a.x, a.y, radius));
      continue;
    }
    const nx = (-dy / length) * radius,
      ny = (dx / length) * radius,
      r = n(radius);
    path.push(
      `M${n(a.x + nx)},${n(a.y + ny)}L${n(b.x + nx)},${n(b.y + ny)}A${r},${r} 0 0 0 ${n(b.x - nx)},${n(b.y - ny)}L${n(a.x - nx)},${n(a.y - ny)}A${r},${r} 0 0 0 ${n(a.x + nx)},${n(a.y + ny)}Z`,
    );
  }
  return path.join('');
}
