import type { Vec2 } from "./schema";

export const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function polygonSignedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  const A = polygonSignedArea(poly);
  if (Math.abs(A) < 1e-9) {
    const s = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: s.x / poly.length, y: s.y / poly.length };
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

export function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A point inside the polygon suitable for a label (centroid if inside, else best interior sample). */
export function labelPoint(poly: Vec2[]): Vec2 {
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly)) return c;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best = poly[0], bestD = -1;
  for (let i = 1; i < 12; i++)
    for (let j = 1; j < 12; j++) {
      const p = { x: x0 + ((x1 - x0) * i) / 12, y: y0 + ((y1 - y0) * j) / 12 };
      if (!pointInPolygon(p, poly)) continue;
      const d = Math.min(...poly.map((_, k) => distToSegment(p, poly[k], poly[(k + 1) % poly.length])));
      if (d > bestD) { bestD = d; best = p; }
    }
  return best;
}

export function dist(a: Vec2, b: Vec2) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

export function bboxOf(points: Vec2[]) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Does segment (a,b) share a stretch of length > minLen with polygon edge? Used for adjacency. */
export function sharedEdgeLength(p: Vec2[], q: Vec2[], tol = 0.15): number {
  let total = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j++) {
      const c = q[j], d = q[(j + 1) % q.length];
      total += overlapLength(a, b, c, d, tol);
    }
  }
  return total;
}

function overlapLength(a: Vec2, b: Vec2, c: Vec2, d: Vec2, tol: number) {
  const L = dist(a, b);
  if (L < 1e-6) return 0;
  if (distToLine(c, a, b) > tol || distToLine(d, a, b) > tol) return 0;
  const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  const tc = (c.x - a.x) * ux + (c.y - a.y) * uy;
  const td = (d.x - a.x) * ux + (d.y - a.y) * uy;
  const lo = Math.max(0, Math.min(tc, td)), hi = Math.min(L, Math.max(tc, td));
  return Math.max(0, hi - lo);
}

function distToLine(p: Vec2, a: Vec2, b: Vec2) {
  const L = dist(a, b);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L;
}

export const SQFT_PER_M2 = 10.7639;
