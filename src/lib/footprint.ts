// Plan-space footprints: the union of room outlines, grown or shrunk by a distance, and traced back to
// polygons. Done on a fine raster, so any mix of overlapping, touching or gapped room outlines works; plans
// drawn square to the grid come out exact, diagonal walls within one cell.
//
// Used for floor plates and roofs (the storey's outline plus its overhang), the paved apron around a house,
// and the plot when the brochure does not draw one.
import type { Vec2 } from "./schema";

export type Grid = { x0: number; y0: number; res: number; w: number; h: number; data: Uint8Array };
export type Outline = { outer: Vec2[]; holes: Vec2[][] };

export function bboxOf(polys: Vec2[][]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const v of p) {
    minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
  }
  return { minX, minY, maxX, maxY };
}

export function emptyGrid(minX: number, minY: number, maxX: number, maxY: number, res: number): Grid {
  const x0 = Math.floor(minX / res) * res, y0 = Math.floor(minY / res) * res;
  const w = Math.max(1, Math.ceil((maxX - x0) / res)), h = Math.max(1, Math.ceil((maxY - y0) / res));
  return { x0, y0, res, w, h, data: new Uint8Array(w * h) };
}

/** Fill the polygons into the grid (a cell is inside when its centre is). */
export function fill(g: Grid, polys: Vec2[][], value = 1) {
  for (const poly of polys) {
    if (poly.length < 3) continue;
    for (let j = 0; j < g.h; j++) {
      const y = g.y0 + (j + 0.5) * g.res;
      const xs: number[] = [];
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const a = poly[i], b = poly[k];
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - g.x0) / g.res - 0.5));
        const i1 = Math.min(g.w - 1, Math.floor((xs[n + 1] - g.x0) / g.res - 0.5));
        for (let i = i0; i <= i1; i++) g.data[j * g.w + i] = value;
      }
    }
  }
  return g;
}

/** Union of polygons on a grid with `margin` metres of empty border (room for growing it). */
export function rasterize(polys: Vec2[][], res = 0.1, margin = 2): Grid {
  const b = bboxOf(polys);
  if (!isFinite(b.minX)) return emptyGrid(0, 0, 1, 1, res);
  return fill(emptyGrid(b.minX - margin, b.minY - margin, b.maxX + margin, b.maxY + margin, res), polys);
}

/** Grow (r > 0) or shrink (r < 0) the filled area by |r| metres (square corners stay square). */
export function offsetGrid(g: Grid, r: number): Grid {
  const n = Math.round(Math.abs(r) / g.res);
  if (!n) return { ...g, data: g.data.slice() };
  const grow = r > 0;
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    const { w, h } = g;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let v = grow ? 0 : 1;
      for (let k = -n; k <= n; k++) {
        const ii = horizontal ? i + k : i, jj = horizontal ? j : j + k;
        const inside = ii >= 0 && jj >= 0 && ii < w && jj < h ? src[jj * w + ii] : 0;
        if (grow && inside) { v = 1; break; }
        if (!grow && !inside) { v = 0; break; }
      }
      out[j * w + i] = v;
    }
    return out;
  };
  return { ...g, data: pass(pass(g.data, true), false) };
}

/** Cells in `a` and not in `b` (same grid). */
export function subtract(a: Grid, b: Grid): Grid {
  const data = a.data.slice();
  for (let k = 0; k < data.length; k++) if (b.data[k]) data[k] = 0;
  return { ...a, data };
}

export function union(a: Grid, b: Grid): Grid {
  const data = a.data.slice();
  for (let k = 0; k < data.length; k++) if (b.data[k]) data[k] = 1;
  return { ...a, data };
}

export function cellAt(g: Grid, p: Vec2): boolean {
  const i = Math.floor((p.x - g.x0) / g.res), j = Math.floor((p.y - g.y0) / g.res);
  return i >= 0 && j >= 0 && i < g.w && j < g.h && g.data[j * g.w + i] === 1;
}

export function filledArea(g: Grid) {
  let n = 0;
  for (let k = 0; k < g.data.length; k++) n += g.data[k];
  return n * g.res * g.res;
}

/** Trace the filled area back to polygons: outer boundaries counter-clockwise with their holes clockwise. */
export function outlines(g: Grid, tolerance = g.res * 2): Outline[] {
  const { w, h } = g;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && g.data[j * w + i] === 1;
  // boundary edges between filled and empty cells, walked with the filled side on the left
  const out = new Map<number, number[]>(); // vertex key → end vertex keys
  const key = (i: number, j: number) => j * (w + 1) + i;
  const add = (a: number, b: number) => { const l = out.get(a); if (l) l.push(b); else out.set(a, [b]); };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!at(i, j)) continue;
    if (!at(i, j - 1)) add(key(i, j), key(i + 1, j));
    if (!at(i + 1, j)) add(key(i + 1, j), key(i + 1, j + 1));
    if (!at(i, j + 1)) add(key(i + 1, j + 1), key(i, j + 1));
    if (!at(i - 1, j)) add(key(i, j + 1), key(i, j));
  }
  const xy = (k: number) => ({ i: k % (w + 1), j: Math.floor(k / (w + 1)) });
  const loops: Vec2[][] = [];
  for (const start of [...out.keys()]) {
    while ((out.get(start)?.length ?? 0) > 0) {
      const loop: number[] = [start];
      let prev = start;
      let cur = out.get(start)!.shift()!;
      let guard = 0;
      while (cur !== start && guard++ < 1e6) {
        loop.push(cur);
        const nexts = out.get(cur);
        if (!nexts?.length) break;
        let pick = 0;
        if (nexts.length > 1) {
          // at a pinch (two filled cells touching only at a corner) turn left, so each keeps its own loop
          const a = xy(prev), b = xy(cur);
          const dx = b.i - a.i, dy = b.j - a.j;
          const turn = (k: number) => { const c = xy(k); return dx * (c.j - b.j) - dy * (c.i - b.i); };
          pick = nexts.map((k, n) => [turn(k), n]).sort((p, q) => q[0] - p[0])[0][1];
        }
        prev = cur;
        cur = nexts.splice(pick, 1)[0];
      }
      const pts = loop.map((k) => { const { i, j } = xy(k); return { x: g.x0 + i * g.res, y: g.y0 + j * g.res }; });
      const simple = simplify(pts, tolerance);
      if (simple.length >= 3) loops.push(simple);
    }
  }
  const outers = loops.filter((l) => signedArea(l) > 0).map((outer) => ({ outer, holes: [] as Vec2[][] }));
  for (const hole of loops.filter((l) => signedArea(l) < 0)) {
    const owner = outers.filter((o) => pointIn(hole[0], o.outer)).sort((a, b) => signedArea(a.outer) - signedArea(b.outer))[0];
    owner?.holes.push(hole);
  }
  return outers;
}

export function signedArea(p: Vec2[]) {
  let s = 0;
  for (let i = 0, k = p.length - 1; i < p.length; k = i++) s += p[k].x * p[i].y - p[i].x * p[k].y;
  return s / 2;
}

function pointIn(pt: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Drop collinear points, then Douglas–Peucker on the closed loop (staircase edges of diagonal walls). */
function simplify(pts: Vec2[], tol: number): Vec2[] {
  const noCollinear = (p: Vec2[]) => p.filter((v, i) => {
    const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    return Math.abs((v.x - a.x) * (b.y - a.y) - (v.y - a.y) * (b.x - a.x)) > 1e-9;
  });
  let p = noCollinear(pts);
  if (p.length <= 4) return p;
  // split the loop at its two farthest-apart points and simplify each half
  let far = 0, fd = -1;
  for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i].x - p[0].x, p[i].y - p[0].y); if (d > fd) { fd = d; far = i; } }
  const dp = (seg: Vec2[]): Vec2[] => {
    if (seg.length <= 2) return seg;
    const a = seg[0], b = seg[seg.length - 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
    let idx = 0, md = -1;
    for (let i = 1; i < seg.length - 1; i++) {
      const d = Math.abs((seg[i].x - a.x) * (b.y - a.y) - (seg[i].y - a.y) * (b.x - a.x)) / L;
      if (d > md) { md = d; idx = i; }
    }
    if (md <= tol) return [a, b];
    const left = dp(seg.slice(0, idx + 1)), right = dp(seg.slice(idx));
    return [...left.slice(0, -1), ...right];
  };
  const h1 = dp(p.slice(0, far + 1)), h2 = dp([...p.slice(far), p[0]]);
  p = [...h1.slice(0, -1), ...h2.slice(0, -1)];
  return noCollinear(p).map((v) => ({ x: Math.round(v.x * 1000) / 1000, y: Math.round(v.y * 1000) / 1000 }));
}

/** Polygons of the union of `polys` grown by `offsetM` (negative shrinks). */
export function footprint(polys: Vec2[][], offsetM = 0, res = 0.1): Outline[] {
  const g = rasterize(polys, res, Math.max(1, offsetM + 1));
  return outlines(offsetM ? offsetGrid(g, offsetM) : g);
}
