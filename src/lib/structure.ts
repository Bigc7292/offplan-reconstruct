// Structure and site the plans imply but do not draw as geometry: floor plates and roofs with their slab
// edges, stairs between floors, pool shells, sunken seating, parking bays, and the plot with its paving,
// lawn, boundary wall and planting. Everything here is marked inferred unless the reading traced it.
//
// Plan space is x east, y north (metres); three.js space is (x, elevation, -y).
import type { Level, PropertyDossier, Room, ScenePiece, Vec2, BoxShape } from "./schema";
import { emptyGrid, fill, offsetGrid, outlines, subtract, bboxOf, type Grid } from "./footprint";
import { polygonArea, polygonCentroid, pointInPolygon } from "./geom";
import { roomKind } from "./staging";
import { circle, hash01 } from "./furniture";

export type Emit = {
  push: (p: Omit<ScenePiece, "id">) => void;
  /** material id for a role (soffit, fascia, roof, paving, lawn, hedge, leaf, trunk, boundary, gate, coping, pooltile, water, stair, glass, frame, concrete, bayline, asphalt, carpaint*, tyre, carglass, light, outdoor, facade, screen) */
  mat: (role: string) => string;
};

export const PLATE_T = 0.3;
export const PLATE_TOP = -0.03; // plate top relative to the storey's floor level

export type Storey = {
  level: Level; E: number; ceilingH: number; wallTop: number; street: boolean; lowest: boolean; top: boolean;
  above?: Storey; below?: Storey;
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const isPool = (r: Room) => roomKind(r) === "pool";
const isSunken = (r: Room) => roomKind(r) === "sunken";
const isRamp = (r: Room) => /\bramp\b/i.test(r.name);
const isDouble = (r: Room) => /double.?height|\bvoid\b|atrium/i.test(r.name);
export const isOutdoor = (r: Room) => ["terrace", "pool", "sunken", "bbq"].includes(roomKind(r)) || r.program === "balcony";

export function storeys(levels: Level[], ceilingOf: (l: Level) => number): Storey[] {
  const sorted = [...levels].sort((a, b) => a.elevationM - b.elevationM);
  const street = [...sorted].sort((a, b) => Math.abs(a.elevationM) - Math.abs(b.elevationM))[0];
  const out: Storey[] = sorted.map((level, i) => ({
    level, E: level.elevationM, ceilingH: ceilingOf(level), wallTop: 0, street: level === street, lowest: i === 0, top: i === sorted.length - 1,
  }));
  out.forEach((s, i) => {
    s.below = out[i - 1];
    s.above = out[i + 1];
    const gap = s.above ? s.above.E - s.E : 0;
    s.wallTop = s.above && gap > s.ceilingH + 0.2 && gap < 8 ? r3(gap + PLATE_TOP - PLATE_T) : r3(s.ceilingH + 0.05);
    if (s.above && !(gap > s.ceilingH + 0.2 && gap < 8)) s.above = undefined;
  });
  return out;
}

function gridFor(all: Vec2[][], margin: number): () => Grid {
  const b = bboxOf(all);
  return () => emptyGrid(b.minX - margin, b.minY - margin, b.maxX + margin, b.maxY + margin, 0.1);
}

/** A box between two plan points (a thin slab along a line), heights absolute. */
export function lineBox(a: Vec2, b: Vec2, y0: number, y1: number, thick: number, shift = 0, extend = 0): BoxShape {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
  const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  const cx = (a.x + b.x) / 2 - uy * shift, cy = (a.y + b.y) / 2 + ux * shift;
  return { type: "box", center: { x: r3(cx), y: r3((y0 + y1) / 2), z: r3(-cy) }, size: { x: r3(L + extend * 2), y: r3(y1 - y0), z: r3(thick) }, rotY: Math.round(Math.atan2(uy, ux) * 1e5) / 1e5 };
}

/** A box whose long axis runs from S to T (plan x, y and height h), e.g. a stair balustrade or a ramp. */
export function pitchedBox(S: { x: number; y: number; h: number }, T: { x: number; y: number; h: number }, across: number, up: number, lift = 0): BoxShape {
  const dx = T.x - S.x, dy = T.y - S.y, dh = T.h - S.h;
  const Lp = Math.hypot(dx, dy) || 1e-6, L3 = Math.hypot(Lp, dh);
  const wx = dx / L3, wz = -dy / L3, wh = dh / L3;
  const cp = Math.sqrt(Math.max(0, 1 - wh * wh));
  const rotY = Math.atan2(wx, wz);
  const pitch = Math.asin(-wh);
  // local +y after the tilt, to lift the box so its underside runs along S→T
  const upY = cp, upH = Math.sin(pitch) === 0 ? 0 : 0;
  void upH;
  const mid = { x: (S.x + T.x) / 2, y: (S.y + T.y) / 2, h: (S.h + T.h) / 2 + (up / 2 + lift) * upY };
  return { type: "box", center: { x: r3(mid.x), y: r3(mid.h), z: r3(-mid.y) }, size: { x: r3(across), y: r3(up), z: r3(L3) }, rotY: Math.round(rotY * 1e5) / 1e5, pitch: Math.round(pitch * 1e5) / 1e5 };
}

// ───────────────────────── stairs ─────────────────────────

type StairPlan = { path: Vec2[]; width: number; landing: Vec2[] };

/** Stairs between floors: traced walking lines when the reading gave them, else U or dog-leg stairs fitted to the stair rooms. */
export function stairPlans(st: Storey[]): Map<string, StairPlan[]> {
  const out = new Map<string, StairPlan[]>();
  for (const s of st) {
    if (!s.above) continue;
    const plans: StairPlan[] = [];
    for (const t of s.level.stairs ?? []) if (t.path.length >= 2) plans.push({ path: t.path, width: t.widthM, landing: [] });
    if (!plans.length) {
      for (const r of s.level.rooms.filter((x) => /\bstair/i.test(x.name) && x.polygon.length >= 3)) {
        const c = polygonCentroid(r.polygon);
        const up = s.above.level.rooms.find((x) => /\bstair/i.test(x.name) && x.polygon.length >= 3 && (pointInPolygon(c, x.polygon) || pointInPolygon(polygonCentroid(x.polygon), r.polygon)));
        if (!up) continue;
        const lift = s.level.rooms.find((x) => /\belev|\blift\b/i.test(x.name) && pointInPolygon(polygonCentroid(x.polygon), bboxPoly(r.polygon)));
        const p = autoStair(r, lift);
        if (p) plans.push(p);
      }
    }
    if (plans.length) out.set(s.level.id, plans);
  }
  return out;
}

function bboxPoly(p: Vec2[]): Vec2[] {
  const b = bboxOf([p]);
  return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
}

function autoStair(r: Room, lift?: Room): StairPlan | null {
  const b = bboxOf([r.polygon]);
  const W = b.maxX - b.minX, H = b.maxY - b.minY;
  if (Math.min(W, H) < 1.8) return null;
  // which side the flights leave open (the landing): the side the lift touches, else the side nearest the room's middle of mass... default: a short side
  type Side = "N" | "S" | "E" | "W";
  let gap: Side = W >= H ? "E" : "N";
  let w: number;
  if (lift) {
    const lb = bboxOf([lift.polygon]);
    const d: Record<Side, number> = { N: b.maxY - lb.maxY, S: lb.minY - b.minY, E: b.maxX - lb.maxX, W: lb.minX - b.minX };
    gap = (Object.entries(d).sort((p, q) => p[1] - q[1])[0][0]) as Side;
    const arms = (Object.entries(d) as Array<[Side, number]>).filter(([k]) => k !== gap).map(([, v]) => v);
    w = Math.max(0.9, Math.min(1.3, Math.min(...arms)));
  } else {
    w = Math.max(0.9, Math.min(1.3, (Math.min(W, H) - 0.1) / 2));
    gap = W >= H ? "E" : "N";
  }
  const x0 = b.minX + w / 2, x1 = b.maxX - w / 2, y0 = b.minY + w / 2, y1 = b.maxY - w / 2;
  if (x1 - x0 < 0.2 || y1 - y0 < 0.2) return null;
  // walk the three sides away from the gap
  const paths: Record<Side, Vec2[]> = {
    N: [{ x: x0, y: y1 }, { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }],
    S: [{ x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }],
    E: [{ x: x1, y: y0 }, { x: x0, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }],
    W: [{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y0 }, { x: x0, y: y0 }],
  };
  const bands: Record<Side, Vec2[]> = {
    N: [{ x: b.minX, y: b.maxY - w }, { x: b.maxX, y: b.maxY - w }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }],
    S: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.minY + w }, { x: b.minX, y: b.minY + w }],
    E: [{ x: b.maxX - w, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.maxX - w, y: b.maxY }],
    W: [{ x: b.minX, y: b.minY }, { x: b.minX + w, y: b.minY }, { x: b.minX + w, y: b.maxY }, { x: b.minX, y: b.maxY }],
  };
  return { path: paths[gap], width: w, landing: bands[gap] };
}

/** Treads, landings and a glass balustrade along a stair's walking line, rising `rise` metres. */
export function emitStair(e: Emit, levelId: string, E: number, rise: number, plan: StairPlan) {
  const { path, width: w } = plan;
  const n = Math.max(8, Math.round(rise / 0.172));
  const riser = rise / n;
  // runs between corners; corners are square landings
  const segs = path.slice(1).map((p, i) => {
    const a = path[i];
    const L = Math.hypot(p.x - a.x, p.y - a.y);
    const first = i === 0, last = i === path.length - 2;
    const s0 = first ? 0 : w / 2, s1 = last ? L : L - w / 2;
    return { a, u: { x: (p.x - a.x) / L, y: (p.y - a.y) / L }, s0, s1, run: Math.max(0, s1 - s0) };
  });
  const total = segs.reduce((t, s) => t + s.run, 0);
  if (total < 1) return;
  let h = 0, placed = 0;
  const stepMat = e.mat("stair"), glass = e.mat("glass"), rail = e.mat("frame");
  segs.forEach((s, si) => {
    const k = si === segs.length - 1 ? n - placed : Math.round((n * s.run) / total);
    placed += k;
    const going = k ? s.run / k : 0;
    const inward = { x: -s.u.y, y: s.u.x }; // balustrade on the left of the walk (the stair well)
    const start = { x: s.a.x + s.u.x * s.s0, y: s.a.y + s.u.y * s.s0, h };
    for (let i = 0; i < k; i++) {
      h += riser;
      const c0 = s.s0 + going * i, c1 = s.s0 + going * (i + 1);
      const p0 = { x: s.a.x + s.u.x * c0, y: s.a.y + s.u.y * c0 }, p1 = { x: s.a.x + s.u.x * c1, y: s.a.y + s.u.y * c1 };
      // a solid tread block: nosing on top, 14 cm of structure under it
      const shape = lineBox(p0, p1, E + Math.max(0, h - riser - 0.14), E + h, w - 0.04, 0, 0.01);
      e.push({ elementId: `${levelId}-stair`, elementKind: "stair", levelId, materialId: stepMat, inferred: true, shape });
    }
    const end = { x: s.a.x + s.u.x * s.s1, y: s.a.y + s.u.y * s.s1, h };
    if (k > 0) {
      const off = (w / 2 - 0.03);
      const S = { x: start.x + inward.x * off, y: start.y + inward.y * off, h: E + start.h };
      const T = { x: end.x + inward.x * off, y: end.y + inward.y * off, h: E + end.h };
      e.push({ elementId: `${levelId}-stair`, elementKind: "railing", levelId, materialId: glass, inferred: true, shape: pitchedBox(S, T, 0.015, 0.9, 0.05) });
      e.push({ elementId: `${levelId}-stair`, elementKind: "handrail", levelId, materialId: rail, inferred: true, shape: pitchedBox(S, T, 0.05, 0.05, 0.95) });
    }
    // landing at the corner after this run
    if (si < segs.length - 1) {
      const c = path[si + 1];
      e.push({ elementId: `${levelId}-stair`, elementKind: "stair", levelId, materialId: stepMat, inferred: true, shape: { type: "box", center: { x: r3(c.x), y: r3(E + h - 0.09), z: r3(-c.y) }, size: { x: r3(w - 0.04), y: 0.18, z: r3(w - 0.04) }, rotY: 0 } });
    }
  });
}

// ───────────────────────── plates, roofs, slab edges ─────────────────────────

export function emitPlates(e: Emit, st: Storey[], opts: { overhang: number; fascia: boolean; voids: Map<string, Vec2[][]> }) {
  const all = st.flatMap((s) => s.level.rooms.filter((r) => r.polygon.length >= 3).map((r) => r.polygon));
  if (!all.length) return;
  const newGrid = gridFor(all, opts.overhang + 2);
  for (const s of st) {
    const solid = s.level.rooms.filter((r) => r.polygon.length >= 3 && !isPool(r) && !isSunken(r) && !isRamp(r)).map((r) => r.polygon);
    const roofed = (s.below?.level.rooms ?? []).filter((r) => r.polygon.length >= 3 && !isOutdoor(r) && !isDouble(r) && !isRamp(r)).map((r) => r.polygon);
    let g = fill(newGrid(), [...solid, ...roofed]);
    const cantilever = s.below && !s.street && s.E > 0.5;
    if (cantilever && opts.overhang > 0.05) {
      // only the outline of the storey grows; the storey below keeps its own edge
      g = offsetGrid(g, opts.overhang);
    }
    const holes = fill(newGrid(), [
      ...s.level.rooms.filter((r) => (isPool(r) && (s.lowest || s.street)) || isSunken(r) || isRamp(r)).map((r) => r.polygon),
      ...(opts.voids.get(s.level.id) ?? []),
    ]);
    g = subtract(g, holes);
    const T = s.lowest ? 0.25 : PLATE_T;
    const top = s.E + PLATE_TOP;
    for (const o of outlines(g)) {
      e.push({ elementId: `${s.level.id}-plate`, elementKind: "slab", levelId: s.level.id, materialId: e.mat("soffit"), inferred: true, shape: { type: "poly", polygon: o.outer, holes: o.holes, y: r3(top - T), thickness: T } });
      if (cantilever && opts.fascia) edgeBand(e, s.level.id, o.outer, top - T - 0.02, s.E + 0.06, "fascia");
    }
  }
  // roof over the top storey's rooms (and anything open to the sky below it)
  const topS = st[st.length - 1];
  for (const s of st) {
    if (s.above && s !== topS) continue;
    const indoor = s.level.rooms.filter((r) => r.polygon.length >= 3 && !isOutdoor(r) && !isRamp(r)).map((r) => r.polygon);
    if (!indoor.length) continue;
    let g = fill(newGrid(), indoor);
    g = offsetGrid(g, Math.max(0.1, opts.overhang * 1.6));
    const y0 = s.E + s.ceilingH + 0.05;
    for (const o of outlines(g)) {
      e.push({ elementId: `${s.level.id}-roof`, elementKind: "roof", levelId: s.level.id, materialId: e.mat("roof"), inferred: true, shape: { type: "poly", polygon: o.outer, holes: o.holes, y: r3(y0), thickness: 0.3 } });
      if (opts.fascia) edgeBand(e, s.level.id, o.outer, y0 - 0.02, y0 + 0.34, "roof");
    }
  }
}

/** A thin dark band around an outline (slab edge / roof fascia). */
function edgeBand(e: Emit, levelId: string, loop: Vec2[], y0: number, y1: number, kind: "fascia" | "roof") {
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.05) continue;
    // outward of a counter-clockwise loop is to the right of travel: shift by -0.025 along the left normal
    e.push({ elementId: `${levelId}-edge`, elementKind: kind, levelId, materialId: e.mat("fascia"), inferred: true, shape: lineBox(a, b, y0, y1, 0.05, -0.025, 0.05) });
  }
}

// ───────────────────────── pools, sunken seating, parking, ramps ─────────────────────────

export function emitPool(e: Emit, s: Storey, r: Room) {
  const sunk = s.lowest || s.street;
  const E = s.E, id = r.id, L = s.level.id;
  const poly = r.polygon;
  const floorY = sunk ? E - 1.45 : E;
  const waterY = sunk ? E - 0.14 : E + 0.4;
  const rimY = sunk ? E + 0.01 : E + 0.5;
  e.push({ elementId: id, elementKind: "pool", levelId: L, materialId: e.mat("pooltile"), inferred: true, shape: { type: "poly", polygon: poly, y: r3(floorY), thickness: 0.05 } });
  e.push({ elementId: id, elementKind: "pool", levelId: L, materialId: e.mat("water"), inferred: false, shape: { type: "poly", polygon: poly, y: r3(waterY - 0.01), thickness: 0.01 } });
  const ccw = signedArea(poly) > 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    // shell wall just outside the water edge
    e.push({ elementId: id, elementKind: "pool", levelId: L, materialId: e.mat(sunk ? "pooltile" : "coping"), inferred: true, shape: lineBox(a, b, floorY, rimY - 0.05, 0.2, ccw ? -0.1 : 0.1, 0.2) });
  }
  // coping ring
  const g = fill(gridFor([poly], 1)(), [poly]);
  const ring = subtract(offsetGrid(g, 0.35), g);
  for (const o of outlines(ring)) e.push({ elementId: id, elementKind: "pool", levelId: L, materialId: e.mat("coping"), inferred: true, shape: { type: "poly", polygon: o.outer, holes: o.holes, y: r3(rimY - 0.05), thickness: 0.05 } });
  if (sunk) {
    // entry steps across the shortest edge
    let best = 0, bl = Infinity;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const l = Math.hypot(b.x - a.x, b.y - a.y); if (l > 1.2 && l < bl) { bl = l; best = i; } }
    const a = poly[best], b = poly[(best + 1) % poly.length];
    const u = { x: (b.x - a.x) / bl, y: (b.y - a.y) / bl };
    const n = ccw ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
    const sw = Math.min(2.2, bl - 0.2);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (let k = 0; k < 3; k++) {
      const c0 = { x: m.x + n.x * (k * 0.35) - u.x * sw / 2, y: m.y + n.y * (k * 0.35) - u.y * sw / 2 };
      const c1 = { x: c0.x + u.x * sw, y: c0.y + u.y * sw };
      e.push({ elementId: id, elementKind: "pool", levelId: L, materialId: e.mat("coping"), inferred: true, shape: lineBox(c0, c1, floorY, E - 0.35 - k * 0.35, 0.35, ccw ? 0.175 : -0.175) });
    }
  }
}

export function emitSunken(e: Emit, s: Storey, r: Room) {
  const E = s.E, L = s.level.id, poly = r.polygon;
  const base = E - 0.45;
  e.push({ elementId: r.id, elementKind: "floor", levelId: L, materialId: e.mat("paving"), inferred: true, shape: { type: "poly", polygon: poly, y: r3(base - 0.05), thickness: 0.05 } });
  const ccw = signedArea(poly) > 0;
  const edges = poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length] })).map((x) => ({ ...x, L: Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y) }));
  const open = edges.reduce((m, x, i) => (x.L > edges[m].L ? i : m), 0); // steps down on the longest side
  edges.forEach(({ a, b, L: len }, i) => {
    e.push({ elementId: r.id, elementKind: "site", levelId: L, materialId: e.mat("coping"), inferred: true, shape: lineBox(a, b, base - 0.05, E + 0.01, 0.12, ccw ? -0.06 : 0.06, 0.12) });
    if (i === open || len < 1.2) return;
    // built-in bench with a seat cushion along the other sides
    e.push({ elementId: r.id, elementKind: "furniture", levelId: L, materialId: e.mat("coping"), inferred: true, shape: lineBox(a, b, base, base + 0.36, 0.55, ccw ? 0.3 : -0.3, -0.3) });
    e.push({ elementId: r.id, elementKind: "furniture", levelId: L, materialId: e.mat("outdoor"), inferred: true, shape: { ...lineBox(a, b, base + 0.36, base + 0.46, 0.5, ccw ? 0.3 : -0.3, -0.35), bevel: 0.04 } });
  });
  const c = polygonCentroid(poly);
  e.push({ elementId: r.id, elementKind: "furniture", levelId: L, materialId: e.mat("fascia"), inferred: true, shape: { type: "poly", polygon: circle(c.x, c.y, 0.45, 20), y: r3(base), thickness: 0.35 } });
  e.push({ elementId: r.id, elementKind: "light", levelId: L, materialId: e.mat("fire"), inferred: true, shape: { type: "poly", polygon: circle(c.x, c.y, 0.3, 16), y: r3(base + 0.35), thickness: 0.02 } });
}

export function emitRamp(e: Emit, s: Storey, r: Room) {
  if (!s.above) return;
  const b = bboxOf([r.polygon]);
  const alongX = b.maxX - b.minX >= b.maxY - b.minY;
  const rise = s.above.E - s.E;
  const c = polygonCentroid(r.polygon);
  const S = alongX ? { x: b.minX, y: c.y } : { x: c.x, y: b.minY };
  const T = alongX ? { x: b.maxX, y: c.y } : { x: c.x, y: b.maxY };
  const width = (alongX ? b.maxY - b.minY : b.maxX - b.minX) - 0.2;
  // up toward the end farther from the rest of the storey
  const mid = polygonCentroid(s.level.rooms.filter((x) => x !== r && x.polygon.length >= 3).flatMap((x) => x.polygon));
  const upAtT = Math.hypot(T.x - mid.x, T.y - mid.y) > Math.hypot(S.x - mid.x, S.y - mid.y);
  const [lo, hi] = upAtT ? [S, T] : [T, S];
  e.push({ elementId: r.id, elementKind: "floor", levelId: s.level.id, materialId: e.mat("concrete"), inferred: true, shape: pitchedBox({ ...lo, h: s.E }, { ...hi, h: s.E + rise - 0.02 }, width, 0.25, -0.25) });
}

export function emitParking(e: Emit, s: Storey, r: Room, target: number | undefined, used: { n: number }) {
  const E = s.E, L = s.level.id;
  const wash = /wash/i.test(r.name);
  const b = bboxOf([r.polygon]);
  const W = b.maxX - b.minX, H = b.maxY - b.minY;
  const car = (cx: number, cy: number, rotDeg: number, i: number) => {
    const col = ["carpaint1", "carpaint2", "carpaint3", "carpaint4"][Math.floor(hash01(`${r.id}-${i}`) * 4)];
    for (const p of carParts()) {
      const a = (rotDeg * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
      e.push({ elementId: `${r.id}-car${i}`, elementKind: "vehicle", levelId: L, materialId: e.mat(p.mat === "paint" ? col : p.mat), inferred: true, shape: { type: "box", center: { x: r3(cx + p.dx * co - p.dy * si), y: r3(E + (p.y0 + p.y1) / 2), z: r3(-(cy + p.dx * si + p.dy * co)) }, size: { x: p.w, y: r3(p.y1 - p.y0), z: p.d }, rotY: Math.round(a * 1e5) / 1e5, bevel: p.bevel } });
    }
  };
  if (wash) {
    const c = polygonCentroid(r.polygon);
    car(c.x, c.y, W > H ? 90 : 0, 0);
    return;
  }
  // bays 2.5 × 5.0 in rows along the long side, a 6 m aisle between facing rows
  const alongX = W >= H;
  const long = alongX ? W : H, short = alongX ? H : W;
  const rows: Array<{ off: number; facing: 1 | -1 }> = [];
  if (short >= 16) rows.push({ off: 0, facing: 1 }, { off: short - 5, facing: -1 });
  else if (short >= 5.2) rows.push({ off: short >= 11 ? 0 : (short - 5) / 2, facing: 1 });
  const line = (p0: Vec2, p1: Vec2) => e.push({ elementId: `${r.id}-bays`, elementKind: "site", levelId: L, materialId: e.mat("bayline"), inferred: true, shape: lineBox(p0, p1, E + 0.001, E + 0.006, 0.1) });
  const P = (along: number, across: number): Vec2 => (alongX ? { x: b.minX + along, y: b.minY + across } : { x: b.minX + across, y: b.minY + along });
  for (const row of rows) {
    const n = Math.floor((long - 0.4) / 2.5);
    for (let i = 0; i < n; i++) {
      if (target !== undefined && used.n >= target) return;
      const a0 = 0.2 + i * 2.5, a1 = a0 + 2.5;
      const corners = [P(a0, row.off), P(a1, row.off), P(a1, row.off + 5), P(a0, row.off + 5)];
      if (!corners.every((c) => pointInPolygon(c, r.polygon))) continue;
      used.n++;
      line(P(a0, row.off), P(a0, row.off + 5));
      line(P(a1, row.off), P(a1, row.off + 5));
      if (hash01(`${r.id}-bay${used.n}`) < 0.62) {
        const c = P(a0 + 1.25, row.off + 2.5);
        car(c.x, c.y, alongX ? 0 : 90, used.n);
      }
    }
  }
}

function carParts() {
  // along plan +y (rotation 0), 1.9 × 4.7 m
  const W = 1.9, L = 4.7;
  const parts: Array<{ dx: number; dy: number; w: number; d: number; y0: number; y1: number; mat: string; bevel?: number }> = [
    { dx: 0, dy: 0, w: W, d: L, y0: 0.3, y1: 0.92, mat: "paint", bevel: 0.14 },
    { dx: 0, dy: -0.25, w: W - 0.22, d: L * 0.48, y0: 0.9, y1: 1.4, mat: "carglass", bevel: 0.16 },
    { dx: 0, dy: -0.25, w: W - 0.34, d: L * 0.44, y0: 1.38, y1: 1.44, mat: "paint", bevel: 0.04 },
  ];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push({ dx: sx * (W / 2 - 0.14), dy: sy * (L / 2 - 0.78), w: 0.24, d: 0.68, y0: 0, y1: 0.66, mat: "tyre", bevel: 0.12 });
  return parts;
}

// ───────────────────────── site ─────────────────────────

export function emitSite(e: Emit, st: Storey[], d: PropertyDossier) {
  const street = st.find((s) => s.street);
  if (!street) return;
  const E = street.E;
  const L = street.level.id;
  const site = street.level.site;
  const houseAll = st.filter((s) => s.E <= E + 0.1).flatMap((s) => s.level.rooms.filter((r) => r.polygon.length >= 3).map((r) => r.polygon));
  const streetRooms = street.level.rooms.filter((r) => r.polygon.length >= 3);
  if (!houseAll.length) return;
  // the plot: traced, or grown around the building to the printed plot area
  let plot = site?.plot && site.plot.length >= 3 ? site.plot : undefined;
  if (!plot) {
    const bb = bboxOf(houseAll);
    const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    const area = Number(d.facts.find((f) => /plot/i.test(f.key) && /m2|sqm|m²/i.test(f.key + f.value))?.value.replace(/[^\d.]/g, "")) || 0;
    let m = 3;
    if (area > w * h) m = Math.max(2, (-(w + h) + Math.sqrt((w + h) ** 2 + 4 * (area - w * h))) / 4);
    m = Math.min(m, 12);
    plot = [{ x: bb.minX - m, y: bb.minY - m }, { x: bb.maxX + m, y: bb.minY - m }, { x: bb.maxX + m, y: bb.maxY + m }, { x: bb.minX - m, y: bb.maxY + m }];
  }
  const newGrid = gridFor([plot, ...houseAll], 30);
  const plotG = fill(newGrid(), [plot]);
  const roomsG = fill(newGrid(), streetRooms.map((r) => r.polygon));
  const rampG = fill(newGrid(), st.flatMap((s) => s.level.rooms.filter(isRamp).map((r) => r.polygon)));
  const ground = subtract(subtract(plotG, roomsG), rampG);
  // paving around the house and its outdoor rooms, lawn beyond (unless the plan says otherwise)
  let paveG: Grid, lawnG: Grid;
  if (site && (site.lawn.length || site.paving.length)) {
    lawnG = subtract(fill(newGrid(), [...site.lawn, ...site.planting]), subtract(newGrid(), ground));
    lawnG = intersect(lawnG, ground);
    paveG = subtract(ground, lawnG);
  } else {
    const apron = offsetGrid(fill(newGrid(), streetRooms.map((r) => r.polygon)), 2.4);
    paveG = intersect(apron, ground);
    lawnG = subtract(ground, paveG);
  }
  for (const o of outlines(paveG)) e.push({ elementId: "site-paving", elementKind: "site", levelId: L, materialId: e.mat("paving"), inferred: !site, shape: { type: "poly", polygon: o.outer, holes: o.holes, y: r3(E - 0.06), thickness: 0.05 } });
  for (const o of outlines(lawnG)) e.push({ elementId: "site-lawn", elementKind: "site", levelId: L, materialId: e.mat("lawn"), inferred: !site, shape: { type: "poly", polygon: o.outer, holes: o.holes, y: r3(E - 0.07), thickness: 0.05 } });

  // boundary wall with a gate on the street side
  const ccw = signedArea(plot) > 0;
  const gateAt = site?.gate ?? gatePoint(plot, st);
  let gateEdge = -1, gateT = 0;
  let bd = Infinity;
  plot.forEach((a, i) => {
    const b = plot![(i + 1) % plot!.length];
    const Ls = Math.hypot(b.x - a.x, b.y - a.y);
    const t = Math.max(0, Math.min(1, ((gateAt.x - a.x) * (b.x - a.x) + (gateAt.y - a.y) * (b.y - a.y)) / (Ls * Ls)));
    const dd = Math.hypot(a.x + t * (b.x - a.x) - gateAt.x, a.y + t * (b.y - a.y) - gateAt.y);
    if (dd < bd) { bd = dd; gateEdge = i; gateT = t; }
  });
  plot.forEach((a, i) => {
    const b = plot![(i + 1) % plot!.length];
    const Ls = Math.hypot(b.x - a.x, b.y - a.y);
    const wall = (p0: Vec2, p1: Vec2) => e.push({ elementId: "site-boundary", elementKind: "site", levelId: L, materialId: e.mat("boundary"), inferred: true, shape: lineBox(p0, p1, E - 0.07, E + 1.8, 0.2, ccw ? 0.1 : -0.1, 0.1) });
    const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (i !== gateEdge || Ls < 7) { wall(a, b); return; }
    const gw = 5.5 / Ls;
    const t0 = Math.max(0.05, Math.min(0.95 - gw, gateT - gw / 2)), t1 = t0 + gw;
    wall(a, at(t0));
    wall(at(t1), b);
    // a slatted metal gate across the opening
    const g0 = at(t0), g1 = at(t1);
    const n = Math.round((Ls * gw) / 0.12);
    for (let k = 0; k < n; k++) {
      const p = { x: g0.x + ((g1.x - g0.x) * (k + 0.5)) / n, y: g0.y + ((g1.y - g0.y) * (k + 0.5)) / n };
      const q = { x: p.x + ((g1.x - g0.x) / Ls / gw) * 0.04, y: p.y + ((g1.y - g0.y) / Ls / gw) * 0.04 };
      e.push({ elementId: "site-gate", elementKind: "site", levelId: L, materialId: e.mat("gate"), inferred: true, shape: lineBox(p, q, E, E + 1.7, 0.08, ccw ? 0.1 : -0.1) });
    }
    e.push({ elementId: "site-gate", elementKind: "site", levelId: L, materialId: e.mat("gate"), inferred: true, shape: lineBox(g0, g1, E + 1.7, E + 1.78, 0.1, ccw ? 0.1 : -0.1) });
  });

  // hedges along the boundary where it meets lawn, trees in the lawn and a backdrop beyond the plot
  const hedgeBand = intersect(lawnG, subtract(plotG, offsetGrid(plotG, -0.8)));
  for (const o of outlines(hedgeBand)) if (Math.abs(signedArea(o.outer)) > 0.6) e.push({ elementId: "site-hedge", elementKind: "planting", levelId: L, materialId: e.mat("hedge"), inferred: true, shape: { type: "poly", polygon: o.outer, holes: o.holes, y: r3(E - 0.05), thickness: 1.3 } });
  const pb = bboxOf([plot]);
  const trees: Vec2[] = [];
  const clearOfHouse = offsetGrid(fill(newGrid(), houseAll), 3);
  for (let y = pb.minY + 1.8; y < pb.maxY - 1.5; y += 1.5) for (let x = pb.minX + 1.8; x < pb.maxX - 1.5; x += 1.5) {
    const p = { x, y };
    if (!cellIn(lawnG, p) || cellIn(clearOfHouse, p)) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.y - y) < 6)) continue;
    trees.push(p);
    if (trees.length >= 8) break;
  }
  trees.forEach((p, i) => tree(e, L, p, E, i % 2 === 0 ? "palm" : "round", `site-tree${i}`));
  // backdrop: a street beyond the gate and a park-like ring of trees around the plot (illustrative)
  const ring: Vec2[] = [];
  const cx = (pb.minX + pb.maxX) / 2, cy = (pb.minY + pb.maxY) / 2;
  const R = Math.max(pb.maxX - pb.minX, pb.maxY - pb.minY) / 2 + 9;
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2 + hash01(`ring${k}`) * 0.15;
    const rr = R + hash01(`rr${k}`) * 8;
    const p = { x: cx + Math.cos(a) * rr * ((pb.maxX - pb.minX) / 2 + 9) / R, y: cy + Math.sin(a) * rr * ((pb.maxY - pb.minY) / 2 + 9) / R };
    if (Math.hypot(p.x - gateAt.x, p.y - gateAt.y) < 10) continue;
    ring.push(p);
  }
  ring.forEach((p, i) => tree(e, L, p, E, hash01(`kind${i}`) < 0.5 ? "palm" : "round", `site-park${i}`));
}

function gatePoint(plot: Vec2[], st: Storey[]): Vec2 {
  const all = st.flatMap((s) => s.level.rooms);
  const hint = all.find((r) => /ramp|drive|entrance|entry|foyer|gate|porch/i.test(r.name) && r.polygon.length >= 3);
  if (hint) return polygonCentroid(hint.polygon);
  const pool = all.find((r) => isPool(r) && r.polygon.length >= 3);
  const c = polygonCentroid(plot);
  if (pool) { const p = polygonCentroid(pool.polygon); return { x: 2 * c.x - p.x, y: 2 * c.y - p.y }; }
  return { x: c.x, y: bboxOf([plot]).minY };
}

function tree(e: Emit, levelId: string, p: Vec2, E: number, kind: "palm" | "round", id: string) {
  const s = 0.8 + hash01(id) * 0.5;
  if (kind === "palm") {
    const h = 5.5 * s;
    e.push({ elementId: id, elementKind: "planting", levelId, materialId: e.mat("palmtrunk"), inferred: true, shape: { type: "poly", polygon: circle(p.x, p.y, 0.18, 10), y: r3(E - 0.05), thickness: r3(h) } });
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + hash01(id + k) * 0.4;
      const S = { x: p.x, y: p.y, h: E + h };
      const T = { x: p.x + Math.cos(a) * 2.2 * s, y: p.y + Math.sin(a) * 2.2 * s, h: E + h - 0.9 * s };
      e.push({ elementId: id, elementKind: "planting", levelId, materialId: e.mat("leaf"), inferred: true, shape: { ...pitchedBox(S, T, 0.55 * s, 0.06), bevel: 0.02 } });
    }
  } else {
    const h = 2.2 * s;
    e.push({ elementId: id, elementKind: "planting", levelId, materialId: e.mat("trunk"), inferred: true, shape: { type: "poly", polygon: circle(p.x, p.y, 0.15, 8), y: r3(E - 0.05), thickness: r3(h) } });
    e.push({ elementId: id, elementKind: "planting", levelId, materialId: e.mat("leaf"), inferred: true, shape: { type: "poly", polygon: circle(p.x, p.y, 1.5 * s, 14), y: r3(E + h - 0.2), thickness: r3(1.4 * s) } });
    e.push({ elementId: id, elementKind: "planting", levelId, materialId: e.mat("leaf"), inferred: true, shape: { type: "poly", polygon: circle(p.x + 0.2, p.y - 0.1, 1.05 * s, 12), y: r3(E + h + 1.1 * s), thickness: r3(0.9 * s) } });
  }
}

function intersect(a: Grid, b: Grid): Grid {
  const data = a.data.slice();
  for (let k = 0; k < data.length; k++) data[k] = a.data[k] && b.data[k] ? 1 : 0;
  return { ...a, data };
}

function cellIn(g: Grid, p: Vec2) {
  const i = Math.floor((p.x - g.x0) / g.res), j = Math.floor((p.y - g.y0) / g.res);
  return i >= 0 && j >= 0 && i < g.w && j < g.h && g.data[j * g.w + i] === 1;
}

function signedArea(p: Vec2[]) {
  let s = 0;
  for (let i = 0, k = p.length - 1; i < p.length; k = i++) s += p[k].x * p[i].y - p[i].x * p[k].y;
  return s / 2;
}

export { polygonArea };
