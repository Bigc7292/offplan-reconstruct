// Dressing rooms for the walkthrough: a plan rarely draws more than the beds, sofas and kitchen runs, so a
// room that reads as a grey box in 3D is given the pieces a buyer expects to see (bedside tables, a rug, a
// coffee table, stools at the island, curtains at the windows, pendants over the tables). Every piece added
// here is marked illustrative: it shows how the room could be furnished, never what the brochure says.
//
// Pure function of the level, so the same dossier always dresses its rooms the same way.
import type { Furniture, Level, Room, Vec2, Wall } from "./schema";
import { polygonArea, pointInPolygon } from "./geom";

export type Staged = { id: string; kind: string; center: Vec2; sizeM: { w: number; d: number; h: number }; rotationDeg: number; roomId: string };

type Obb = { x: number; y: number; w: number; d: number; a: number };
type Edge = { a: Vec2; b: Vec2; L: number; u: Vec2; n: Vec2 };
type Hole = { c: Vec2; width: number; kind: string; u: Vec2 };

export type RoomKind =
  | "living" | "dining" | "kitchen" | "bedroom" | "staff" | "bath" | "closet" | "terrace" | "bbq" | "pool" | "sunken"
  | "garage" | "circulation" | "service" | "other";

export function roomKind(r: Pick<Room, "name" | "program">): RoomKind {
  const n = r.name.toLowerCase();
  if (/\bpool\b/.test(n) && !/pump|room/.test(n)) return "pool";
  if (/sunken/.test(n)) return "sunken";
  if (/car\b|cars\b|parking|garage|car wash|washing bay/.test(n)) return "garage";
  if (/bbq|barbecue|grill/.test(n)) return "bbq";
  if (r.program === "balcony" || /terrace|balcony|garden|deck|patio|courtyard|lawn/.test(n)) return "terrace";
  if (/maid|driver|chef|staff|nanny|servant|guard/.test(n)) return "staff";
  if (/closet|dress|walk.?in|wardrobe/.test(n)) return "closet";
  if (/dining/.test(n)) return "dining";
  if (r.program === "bath" || /bath|wc\b|powder|toilet|shower|ensuite/.test(n)) return "bath";
  if (r.program === "kitchen" || /kitchen|pantry/.test(n)) return "kitchen";
  if (r.program === "bedroom" || /bed ?room|master|suite|guest room/.test(n)) return "bedroom";
  if (r.program === "living" || /lounge|living|family|majlis|sitting|media|cinema|study|office|library|gym/.test(n)) return "living";
  if (r.program === "circulation" || /lobby|foyer|entrance|hall|corridor|landing|double height/.test(n)) return "circulation";
  if (r.program === "storage" || /store|pump|tank|services|plant|ahu|sump|laundry|elev|lift|stair|shaft|void|duct|electrical/.test(n)) return "service";
  return "other";
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function corners(o: Obb): Vec2[] {
  const c = Math.cos(o.a), s = Math.sin(o.a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const lx = (sx * o.w) / 2, ly = (sy * o.d) / 2;
    return { x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c };
  });
}

function overlap(p: Obb, q: Obb, pad = 0): boolean {
  const P = corners({ ...p, w: p.w + pad * 2, d: p.d + pad * 2 }), Q = corners(q);
  for (const o of [p, q]) {
    for (const ax of [{ x: Math.cos(o.a), y: Math.sin(o.a) }, { x: -Math.sin(o.a), y: Math.cos(o.a) }]) {
      const pr = (pts: Vec2[]) => pts.map((v) => v.x * ax.x + v.y * ax.y);
      const a = pr(P), b = pr(Q);
      if (Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)) return false;
    }
  }
  return true;
}

function edgesOf(poly: Vec2[]): Edge[] {
  const ccw = signed(poly) > 0;
  const out: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 0.3) continue;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    // inward normal: left of travel on a counter-clockwise outline
    const n = ccw ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
    out.push({ a, b, L, u, n });
  }
  return out;
}

function signed(p: Vec2[]) {
  let s = 0;
  for (let i = 0, k = p.length - 1; i < p.length; k = i++) s += p[k].x * p[i].y - p[i].x * p[k].y;
  return s;
}

function bboxOf(poly: Vec2[]) {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Angle that turns a piece's back (+local y) toward a wall whose inward normal is n. */
const backTo = (n: Vec2) => Math.atan2(n.x, -n.y);
/** Plan direction a piece faces (its front, −local y). */
const front = (a: number): Vec2 => ({ x: Math.sin(a), y: -Math.cos(a) });

class RoomStager {
  readonly placed: Obb[] = [];
  readonly rugs: Obb[] = [];
  readonly keepClear: Obb[] = [];
  readonly lowOnly: Obb[] = []; // in front of windows: nothing tall
  readonly out: Staged[] = [];
  readonly edges: Edge[];
  constructor(readonly room: Room, readonly holes: Hole[], existing: Obb[], private readonly idBase: string, private readonly walls: Wall[]) {
    this.edges = edgesOf(room.polygon);
    this.placed.push(...existing);
    for (const h of holes) {
      // stand-off zone in front of each doorway (on both sides; the one outside the room is harmless)
      const clearD = h.kind === "window" ? 0.6 : 1.0;
      const n = { x: -h.u.y, y: h.u.x };
      const zone = (sg: number): Obb => ({ x: h.c.x + n.x * sg * clearD / 2, y: h.c.y + n.y * sg * clearD / 2, w: h.width + 0.2, d: clearD, a: Math.atan2(h.u.y, h.u.x) });
      (h.kind === "window" ? this.lowOnly : this.keepClear).push(zone(1), zone(-1));
    }
  }
  /** Half the thickness of the wall along an edge of the room (outlines run down the middle of walls). */
  wallHalf(e: Edge) {
    let half = 0.08;
    for (const w of this.walls) {
      const d1 = Math.abs((w.a.x - e.a.x) * e.n.x + (w.a.y - e.a.y) * e.n.y), d2 = Math.abs((w.b.x - e.a.x) * e.n.x + (w.b.y - e.a.y) * e.n.y);
      if (d1 > 0.12 || d2 > 0.12) continue;
      const t1 = (w.a.x - e.a.x) * e.u.x + (w.a.y - e.a.y) * e.u.y, t2 = (w.b.x - e.a.x) * e.u.x + (w.b.y - e.a.y) * e.u.y;
      if (Math.max(t1, t2) < 0.1 || Math.min(t1, t2) > e.L - 0.1) continue;
      half = Math.max(half, w.thicknessM / 2);
    }
    return half;
  }
  inside(o: Obb, inset = 0.1) {
    const c = corners({ ...o, w: o.w + inset * 2, d: o.d + inset * 2 });
    const mids = c.map((p, i) => ({ x: (p.x + c[(i + 1) % 4].x) / 2, y: (p.y + c[(i + 1) % 4].y) / 2 }));
    return [...c, ...mids, { x: o.x, y: o.y }].every((p) => pointInPolygon(p, this.room.polygon));
  }
  free(o: Obb, h: number, pad = 0.05) {
    if (!this.inside(o)) return false;
    if (this.placed.some((p) => overlap(o, p, pad))) return false;
    if (this.keepClear.some((z) => overlap(o, z))) return false;
    if (h > 1.0 && this.lowOnly.some((z) => overlap(o, z))) return false;
    return true;
  }
  add(kind: string, o: Obb, h: number, opts: { rug?: boolean; ignoreClear?: boolean } = {}) {
    if (opts.rug) {
      if (!this.inside(o, 0.15) || this.rugs.some((r) => overlap(o, r))) return false;
      this.rugs.push(o);
    } else if (!opts.ignoreClear) {
      if (!this.free(o, h)) return false;
      this.placed.push(o);
    }
    this.out.push({ id: `${this.idBase}-s${this.out.length + 1}`, kind, center: { x: r3(o.x), y: r3(o.y) }, sizeM: { w: r3(o.w), d: r3(o.d), h }, rotationDeg: deg(o.a), roomId: this.room.id });
    return true;
  }
  /** A piece of size w × d standing with its back to edge e, centred at fraction t along it. */
  against(e: Edge, t: number, w: number, d: number, gap = 0.02): Obb {
    gap += this.wallHalf(e);
    const px = e.a.x + e.u.x * e.L * t + e.n.x * (d / 2 + gap);
    const py = e.a.y + e.u.y * e.L * t + e.n.y * (d / 2 + gap);
    return { x: px, y: py, w, d, a: backTo(e.n) };
  }
  holesOn(e: Edge) {
    return this.holes.filter((h) => {
      const t = (h.c.x - e.a.x) * e.u.x + (h.c.y - e.a.y) * e.u.y;
      const off = Math.abs((h.c.x - e.a.x) * e.n.x + (h.c.y - e.a.y) * e.n.y);
      return off < 0.35 && t > -0.2 && t < e.L + 0.2;
    });
  }
  /** Longest stretches of each edge with no door or window, longest first. */
  freeSpans(minLen: number) {
    const spans: Array<{ e: Edge; t0: number; t1: number; len: number }> = [];
    for (const e of this.edges) {
      const cuts = this.holesOn(e).map((h) => {
        const t = (h.c.x - e.a.x) * e.u.x + (h.c.y - e.a.y) * e.u.y;
        return [t - h.width / 2 - 0.15, t + h.width / 2 + 0.15];
      }).sort((p, q) => p[0] - q[0]);
      let cur = 0.1;
      for (const [s, en] of [...cuts, [e.L - 0.1, e.L]]) {
        if (s - cur >= minLen) spans.push({ e, t0: cur / e.L, t1: s / e.L, len: s - cur });
        cur = Math.max(cur, en);
      }
    }
    return spans.sort((p, q) => q.len - p.len);
  }
  /** Distance from p along direction dir to the room outline, and the edge it meets. */
  cast(p: Vec2, dir: Vec2): { dist: number; e: Edge; t: number } | null {
    let best: { dist: number; e: Edge; t: number } | null = null;
    for (const e of this.edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const den = dir.x * dy - dir.y * dx;
      if (Math.abs(den) < 1e-9) continue;
      const s = ((e.a.x - p.x) * dy - (e.a.y - p.y) * dx) / den;
      const t = ((e.a.x - p.x) * dir.y - (e.a.y - p.y) * dir.x) / den;
      if (s > 0.05 && t >= 0 && t <= 1 && (!best || s < best.dist)) best = { dist: s, e, t };
    }
    return best;
  }
  /** Free corners of the room (inside the outline, clear of doors), each with the direction into the room. */
  freeCorners(offset: number) {
    const poly = this.room.polygon;
    const out: Vec2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], a = poly[(i - 1 + poly.length) % poly.length], b = poly[(i + 1) % poly.length];
      const ua = norm({ x: a.x - p.x, y: a.y - p.y }), ub = norm({ x: b.x - p.x, y: b.y - p.y });
      const bis = norm({ x: ua.x + ub.x, y: ua.y + ub.y });
      if (!isFinite(bis.x)) continue;
      const q = { x: p.x + bis.x * (offset + 0.12) * Math.SQRT2, y: p.y + bis.y * (offset + 0.12) * Math.SQRT2 };
      if (pointInPolygon(q, poly)) out.push(q);
    }
    return out;
  }
}

function norm(v: Vec2): Vec2 {
  const L = Math.hypot(v.x, v.y);
  return L ? { x: v.x / L, y: v.y / L } : { x: NaN, y: NaN };
}

function obbOf(f: { center: Vec2; sizeM: { w: number; d: number }; rotationDeg: number }): Obb {
  return { x: f.center.x, y: f.center.y, w: f.sizeM.w, d: f.sizeM.d, a: rad(f.rotationDeg) };
}

/** Openings of a level in plan space, and which rooms they belong to. */
function holesOf(level: Level): Hole[] {
  const out: Hole[] = [];
  for (const w of level.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 0.05) continue;
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    for (const o of w.openings) out.push({ c: { x: w.a.x + (w.b.x - w.a.x) * o.offset, y: w.a.y + (w.b.y - w.a.y) * o.offset }, width: o.widthM, kind: o.kind, u });
    // a glazed wall is one long window as far as furniture is concerned
    if (w.kind === "glass") out.push({ c: { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }, width: L, kind: "glass", u });
  }
  return out;
}

export function stageLevel(level: Level, opts: { top?: boolean } = {}): Staged[] {
  const holes = holesOf(level);
  const staged: Staged[] = [];
  const furniture = level.furniture ?? [];
  for (const room of level.rooms) {
    if (room.polygon.length < 3) continue;
    const area = Math.abs(polygonArea(room.polygon));
    if (area < 2.5) continue;
    const kind = roomKind(room);
    const mine = furniture.filter((f) => pointInPolygon(f.center, room.polygon));
    const near = holes.filter((h) => distToPoly(h.c, room.polygon) < 0.4);
    const s = new RoomStager(room, near, mine.map(obbOf), `${room.id}`, level.walls);
    const b = bboxOf(room.polygon);
    const minDim = Math.min(b.maxX - b.minX, b.maxY - b.minY);
    const of = (k: string[]) => mine.filter((f) => k.includes(f.kind));

    if (kind === "living" || kind === "dining") dressLiving(s, of(["sofa", "armchair"]), of(["dining"]), area, minDim, kind === "dining");
    else if (kind === "bedroom" || kind === "staff") dressBedroom(s, of(["bed_double", "bed_single"]), area, minDim, kind === "staff");
    else if (kind === "kitchen") dressKitchen(s, of(["kitchen_run"]), of(["island"]), of(["dining"]), area, minDim);
    else if (kind === "bath") dressBath(s, mine, area);
    else if (kind === "closet") dressCloset(s, of(["wardrobe"]), area, minDim);
    else if (kind === "terrace") dressTerrace(s, mine, area, minDim, !!opts.top);
    else if (kind === "bbq" && !mine.length) {
      const sp = s.freeSpans(1.4)[0];
      if (sp) s.add("bbq", s.against(sp.e, (sp.t0 + sp.t1) / 2, Math.min(2.4, sp.len - 0.3), 0.65), 0.92);
    } else if (kind === "circulation" && area >= 8) {
      for (const c of s.freeCorners(0.4).slice(0, 1)) s.add("planter", { x: c.x, y: c.y, w: 0.5, d: 0.5, a: 0 }, 1.3);
    }
    if (kind === "living" || kind === "dining" || kind === "bedroom" || kind === "staff") curtains(s);
    staged.push(...s.out);
  }
  return staged;
}

function distToPoly(p: Vec2, poly: Vec2[]) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1e-9;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))));
  }
  return best;
}

function dressLiving(s: RoomStager, seats: Furniture[], tables: Furniture[], area: number, minDim: number, diningRoom: boolean) {
  let sofa = [...seats].sort((a, b) => b.sizeM.w * b.sizeM.d - a.sizeM.w * a.sizeM.d)[0] as { center: Vec2; sizeM: { w: number; d: number; h: number }; rotationDeg: number } | undefined;
  if (!sofa && !tables.length && !diningRoom && area >= 11 && minDim >= 2.8) {
    // nothing drawn: a sofa facing a media wall (the longest wall without a door or window)
    const sp = s.freeSpans(2.4)[0];
    if (sp) {
      const t = (sp.t0 + sp.t1) / 2;
      const w = Math.min(3.0, Math.max(2.0, sp.len * 0.6));
      const depth = s.cast({ x: sp.e.a.x + sp.e.u.x * sp.e.L * t, y: sp.e.a.y + sp.e.u.y * sp.e.L * t }, sp.e.n)?.dist ?? 4;
      s.add("media_unit", s.against(sp.e, t, Math.min(2.4, w), 0.45), 0.5);
      for (const D of [Math.min(3.4, depth - 0.7), 3.0, 2.6, 2.3]) {
        if (D < 2.0) continue;
        const o = s.against(sp.e, t, w, 0.95, D - 0.475);
        o.a = backTo({ x: -sp.e.n.x, y: -sp.e.n.y });
        if (s.add("sofa", o, 0.8)) { sofa = { center: { x: o.x, y: o.y }, sizeM: { w, d: 0.95, h: 0.8 }, rotationDeg: deg(o.a) }; break; }
      }
      if (sofa) {
        // two armchairs at the sides, turned in
        const a = rad(sofa.rotationDeg), f = front(a), ux = { x: Math.cos(a), y: Math.sin(a) };
        const mid = { x: sofa.center.x + f.x * 1.2, y: sofa.center.y + f.y * 1.2 };
        for (const sg of [-1, 1]) {
          const c = { x: mid.x + ux.x * sg * (w / 2 + 0.6), y: mid.y + ux.y * sg * (w / 2 + 0.6) };
          s.add("armchair", { x: c.x, y: c.y, w: 0.85, d: 0.85, a: a - (sg * Math.PI) / 2 }, 0.8);
        }
      }
    }
  }
  if (sofa) {
    const a = rad(sofa.rotationDeg), f = front(a), ux = { x: Math.cos(a), y: Math.sin(a) };
    const sw = sofa.sizeM.w, sd = sofa.sizeM.d;
    let table: Obb | null = null;
    for (const [tw, td, gap] of [[Math.min(1.3, sw * 0.55), 0.7, 0.45], [0.9, 0.55, 0.4], [0.8, 0.8, 0.4]] as const) {
      const off = sd / 2 + gap + td / 2;
      const o = { x: sofa.center.x + f.x * off, y: sofa.center.y + f.y * off, w: tw, d: td, a };
      if (s.add("coffee_table", o, 0.4)) { table = o; break; }
    }
    const rc = table ?? { x: sofa.center.x + f.x * (sd / 2 + 0.8), y: sofa.center.y + f.y * (sd / 2 + 0.8) };
    for (const [rw, rd] of [[sw + 0.9, 2.8], [sw + 0.5, 2.4], [Math.max(1.8, sw), 2.0], [1.7, 1.7]]) {
      // the rug runs under the front of the sofa
      const shift = (rd / 2 - (sd / 2 + 0.35)) - Math.hypot(rc.x - sofa.center.x, rc.y - sofa.center.y);
      if (s.add("rug", { x: rc.x + f.x * shift * 0.5, y: rc.y + f.y * shift * 0.5, w: rw, d: rd, a }, 0.012, { rug: true })) break;
    }
    for (const sg of [-1, 1]) {
      const back = { x: -f.x * (sd / 2 - 0.3), y: -f.y * (sd / 2 - 0.3) };
      s.add("side_table", { x: sofa.center.x + ux.x * sg * (sw / 2 + 0.32) + back.x, y: sofa.center.y + ux.y * sg * (sw / 2 + 0.32) + back.y, w: 0.46, d: 0.46, a }, 0.55);
    }
    // a media unit on the wall the sofa faces, when that wall is clear
    const hit = s.cast(sofa.center, f);
    if (hit && hit.dist > 2.2 && hit.dist < 7) {
      const t = hit.t;
      const clear = s.holesOn(hit.e).every((h) => Math.abs((h.c.x - hit.e.a.x) * hit.e.u.x + (h.c.y - hit.e.a.y) * hit.e.u.y - t * hit.e.L) > h.width / 2 + 1.2);
      if (clear) s.add("media_unit", s.against(hit.e, t, Math.min(2.4, sw + 0.2), 0.45), 0.5);
    }
    if (table && !tables.length) s.add("pendant", { ...table, w: 0.7, d: 0.7 }, 0.3, { ignoreClear: true });
  }
  for (const t of tables) {
    const long = Math.max(t.sizeM.w, t.sizeM.d), short = Math.min(t.sizeM.w, t.sizeM.d);
    if (long - short < 0.25) s.add("pendant", { x: t.center.x, y: t.center.y, w: Math.min(0.8, long * 0.5), d: 0.6, a: 0 }, 0.3, { ignoreClear: true });
    else s.add("linear_pendant", { x: t.center.x, y: t.center.y, w: long * 0.6, d: 0.1, a: rad(t.rotationDeg) + (t.sizeM.w >= t.sizeM.d ? 0 : Math.PI / 2) }, 0.3, { ignoreClear: true });
  }
  let plants = 0;
  for (const c of s.freeCorners(0.42)) {
    if (plants >= (area > 30 ? 2 : 1)) break;
    if (s.add("planter", { x: c.x, y: c.y, w: 0.55, d: 0.55, a: 0 }, 1.4)) plants++;
  }
}

function dressBedroom(s: RoomStager, beds: Furniture[], area: number, minDim: number, staff: boolean) {
  let bed = [...beds].sort((a, b) => b.sizeM.w * b.sizeM.d - a.sizeM.w * a.sizeM.d)[0] as { center: Vec2; sizeM: { w: number; d: number; h: number }; rotationDeg: number; kind: string } | undefined;
  if (!bed && area >= 6.5 && minDim >= 2.2) {
    const double = !staff && area >= 11;
    const bw = double ? (area >= 16 ? 2.0 : 1.8) : 1.0;
    const sp = s.freeSpans(bw + (double ? 1.1 : 0.3))[0];
    if (sp) {
      const o = s.against(sp.e, (sp.t0 + sp.t1) / 2, bw, 2.1);
      if (s.add(double ? "bed_double" : "bed_single", o, 0.55)) bed = { center: { x: o.x, y: o.y }, sizeM: { w: bw, d: 2.1, h: 0.55 }, rotationDeg: deg(o.a), kind: double ? "bed_double" : "bed_single" };
    }
  }
  if (staff && !s.placed.some((p) => p.w >= 0.9 && p.d <= 0.7) && area >= 7) {
    const sp = s.freeSpans(1.3)[0];
    if (sp) s.add("wardrobe", s.against(sp.e, (sp.t0 + sp.t1) / 2, Math.min(1.6, sp.len - 0.1), 0.6), 2.3);
  }
  if (!bed) return;
  const a = rad(bed.rotationDeg), f = front(a), ux = { x: Math.cos(a), y: Math.sin(a) };
  const single = bed.kind === "bed_single" || bed.sizeM.w < 1.3;
  const bw = Math.min(bed.sizeM.w, single ? 1.1 : 2.0), bd = Math.min(bed.sizeM.d, 2.2);
  const head = { x: bed.center.x - f.x * (bed.sizeM.d / 2 - 0.26), y: bed.center.y - f.y * (bed.sizeM.d / 2 - 0.26) };
  if (bed.sizeM.w - bw < 0.7) {
    for (const sg of single ? [1] : [-1, 1]) {
      s.add("nightstand", { x: head.x + ux.x * sg * (bw / 2 + 0.32), y: head.y + ux.y * sg * (bw / 2 + 0.32), w: 0.5, d: 0.42, a }, 0.55);
    }
  }
  if (staff) return;
  for (const [rw, rd] of [[bw + 1.4, 2.4], [bw + 1.0, 2.1], [bw + 0.6, 1.8]]) {
    const off = bd / 2 - rd / 2 + 0.75; // from the bed's middle toward its foot
    if (s.add("rug", { x: bed.center.x + f.x * off, y: bed.center.y + f.y * off, w: rw, d: rd, a }, 0.012, { rug: true })) break;
  }
  const hit = s.cast(bed.center, f);
  const footGap = hit ? hit.dist - bd / 2 : 0;
  if (footGap >= 1.35) s.add("bench", { x: bed.center.x + f.x * (bd / 2 + 0.3), y: bed.center.y + f.y * (bd / 2 + 0.3), w: bw * 0.75, d: 0.42, a }, 0.45);
  if (hit && footGap >= 2.1) {
    const clear = s.holesOn(hit.e).every((h) => Math.abs((h.c.x - hit.e.a.x) * hit.e.u.x + (h.c.y - hit.e.a.y) * hit.e.u.y - hit.t * hit.e.L) > h.width / 2 + 1.0);
    if (clear) s.add(area >= 20 ? "media_unit" : "dresser", s.against(hit.e, hit.t, area >= 20 ? 1.8 : 1.3, 0.48), 0.8);
  }
  if (area >= 15) {
    for (const c of s.freeCorners(0.55)) {
      const toMid = norm({ x: bed.center.x - c.x, y: bed.center.y - c.y });
      if (s.add("armchair", { x: c.x, y: c.y, w: 0.8, d: 0.8, a: backTo({ x: toMid.x, y: toMid.y }) }, 0.8)) break;
    }
  }
  for (const c of s.freeCorners(0.35)) if (s.add("planter", { x: c.x, y: c.y, w: 0.45, d: 0.45, a: 0 }, 1.2)) break;
}

function dressKitchen(s: RoomStager, runs: Furniture[], islands: Furniture[], tables: Furniture[], area: number, minDim: number) {
  if (!runs.length && !islands.length && area >= 5) {
    const sp = s.freeSpans(1.8)[0];
    if (sp) {
      const w = Math.min(3.6, sp.len - 0.1);
      const run = s.against(sp.e, (sp.t0 + sp.t1) / 2, w, 0.62);
      s.add("kitchen_run", run, 0.92);
      if (area >= 14 && minDim >= 3.6) {
        const off = 0.62 + 1.1 + 0.5;
        s.add("island", { x: run.x + sp.e.n.x * (off - 0.31), y: run.y + sp.e.n.y * (off - 0.31), w: Math.min(2.4, w - 0.6), d: 1.0, a: run.a }, 0.92);
      }
    }
  }
  for (const isl of islands) {
    const a = rad(isl.rotationDeg);
    const alongX = isl.sizeM.w >= isl.sizeM.d;
    const long = Math.max(isl.sizeM.w, isl.sizeM.d), short = Math.min(isl.sizeM.w, isl.sizeM.d);
    const axis = alongX ? { x: Math.cos(a), y: Math.sin(a) } : { x: -Math.sin(a), y: Math.cos(a) };
    const side = { x: -axis.y, y: axis.x };
    // stools on the side away from the nearest kitchen run
    const run = [...runs].sort((p, q) => Math.hypot(p.center.x - isl.center.x, p.center.y - isl.center.y) - Math.hypot(q.center.x - isl.center.x, q.center.y - isl.center.y))[0];
    let sg = 1;
    if (run) sg = (run.center.x - isl.center.x) * side.x + (run.center.y - isl.center.y) * side.y > 0 ? -1 : 1;
    const n = Math.max(1, Math.min(5, Math.floor(long / 0.62)));
    for (let i = 0; i < n; i++) {
      const t = -long / 2 + (long / n) * (i + 0.5);
      s.add("stool", { x: isl.center.x + axis.x * t + side.x * sg * (short / 2 + 0.3), y: isl.center.y + axis.y * t + side.y * sg * (short / 2 + 0.3), w: 0.4, d: 0.4, a: 0 }, 0.75, { ignoreClear: true });
    }
    const np = long >= 2.2 ? 3 : 2;
    for (let i = 0; i < np; i++) {
      const t = -long / 2 + (long / np) * (i + 0.5);
      s.add("pendant", { x: isl.center.x + axis.x * t, y: isl.center.y + axis.y * t, w: 0.32, d: 0.32, a: 0 }, 0.3, { ignoreClear: true });
    }
  }
  for (const t of tables) s.add("pendant", { x: t.center.x, y: t.center.y, w: 0.6, d: 0.6, a: 0 }, 0.3, { ignoreClear: true });
}

function dressBath(s: RoomStager, mine: Furniture[], area: number) {
  const has = (k: string) => mine.some((f) => f.kind === k);
  if (!has("vanity") && area >= 2.5) {
    const sp = s.freeSpans(0.9)[0];
    if (sp) s.add("vanity", s.against(sp.e, (sp.t0 + sp.t1) / 2, Math.min(area >= 6 ? 1.6 : 0.9, sp.len - 0.1), 0.5), 0.85);
  }
  if (!has("wc") && area >= 2.5) {
    for (const sp of s.freeSpans(0.8)) if (s.add("wc", s.against(sp.e, sp.t0 + 0.45 / sp.e.L, 0.4, 0.6), 0.4)) break;
  }
  if (!has("bath") && !has("shower") && area >= 5.5) {
    for (const c of s.freeCorners(0.5)) if (s.add("shower", { x: c.x, y: c.y, w: 1.0, d: 1.0, a: 0 }, 2.1)) break;
  }
}

function dressCloset(s: RoomStager, wardrobes: Furniture[], area: number, minDim: number) {
  if (!wardrobes.length) {
    for (const sp of s.freeSpans(1.0).slice(0, 2)) s.add("wardrobe", s.against(sp.e, (sp.t0 + sp.t1) / 2, sp.len - 0.1, 0.6), 2.4);
  }
  if (area >= 9 && minDim >= 2.8) {
    const c = { x: 0, y: 0 };
    const poly = s.room.polygon;
    for (const p of poly) { c.x += p.x / poly.length; c.y += p.y / poly.length; }
    s.add("dresser", { x: c.x, y: c.y, w: 1.2, d: 0.6, a: 0 }, 0.9);
  }
}

function dressTerrace(s: RoomStager, mine: Furniture[], area: number, minDim: number, top: boolean) {
  if (area < 5 || minDim < 1.4) return;
  if (!mine.length) {
    if (area >= 18 && minDim >= 2.6) {
      // loungers side by side along the longest edge, facing out
      const e = [...s.edges].sort((p, q) => q.L - p.L)[0];
      const n = Math.min(top ? 4 : 2, Math.floor((e.L - 0.8) / 0.9));
      for (let i = 0; i < n; i++) {
        const t = 0.5 + (i - (n - 1) / 2) * (0.9 / e.L);
        const o = s.against(e, t, 0.7, 1.95, 0.35);
        s.add("lounger", o, 0.4);
      }
    } else {
      const c = s.freeCorners(0.8)[0];
      if (c) s.add("dining", { x: c.x, y: c.y, w: 0.8, d: 0.8, a: 0 }, 0.75);
    }
  }
  let plants = 0;
  for (const c of s.freeCorners(0.4)) {
    if (plants >= (area > 30 ? 3 : 1)) break;
    if (s.add("planter", { x: c.x, y: c.y, w: 0.6, d: 0.6, a: 0 }, 1.5)) plants++;
  }
}

/** Sheer curtains stacked either side of each window, glazed door and glazed wall. */
function curtains(s: RoomStager) {
  for (const h of s.holes) {
    if (h.kind !== "window" && h.kind !== "sliding_door" && h.kind !== "glass") continue;
    const n = { x: -h.u.y, y: h.u.x };
    // which side of the opening is the room?
    const probe = { x: h.c.x + n.x * 0.3, y: h.c.y + n.y * 0.3 };
    const sg = pointInPolygon(probe, s.room.polygon) ? 1 : -1;
    const w = Math.min(0.45, Math.max(0.25, h.width * 0.12));
    for (const side of [-1, 1]) {
      const t = side * (h.width / 2 - w / 2);
      const o: Obb = { x: h.c.x + h.u.x * t + n.x * sg * 0.18, y: h.c.y + h.u.y * t + n.y * sg * 0.18, w, d: 0.1, a: Math.atan2(h.u.y, h.u.x) };
      if (s.inside(o, 0) && !s.placed.some((p) => overlap(o, p))) s.add("curtain", o, 2.5, { ignoreClear: true });
    }
  }
}
