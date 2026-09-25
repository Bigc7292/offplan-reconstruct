// Plan sketch → PlanLevel answer, for the Claude Code reading path.
//
// Writing every wall of a floor plan by hand is slow and error-prone. Instead the reader writes a
// compact sketch in the pixel space of the request image: each room outline (as printed), plus the
// doors, windows and glazing it can see. Walls are then derived from the room outlines the same way
// the plan editor's "Walls from rooms" does: an edge two rooms share is an interior wall, an edge only
// one room has is an exterior wall (a railing when the room is outdoors, glass between indoors and
// outdoors). Openings snap to the nearest derived wall.
import type { PlanLevelOut } from "./llm";

type P = [number, number];
export type PlanSketch = {
  levelName: string;
  pxPerMeter: number;
  scaleSource: string;
  scaleConfidence: number;
  northArrowDeg?: number | null;
  /**
   * A point every level shares (e.g. the corner of the lift shaft), given in this image's pixels and in
   * building metres. Floors are cut from different images, so this is what stacks them on top of each other.
   */
  anchor?: { px: P; m: P };
  /** pixel bbox of the drawn plan; defaults to the whole image */
  planBoundsPx?: { x0: number; y0: number; x1: number; y1: number };
  rooms: Array<{
    name: string;
    program: PlanLevelOut["rooms"][number]["program"];
    rect?: [number, number, number, number];
    poly?: P[];
    printed?: string | null;
    printedAreaM2?: number | null;
    /** ground-level open areas (pool, garden, deck): edges no other room shares get no wall or railing */
    open?: boolean;
    /** pixel bbox of the printed label, if different from the room */
    labelBox?: [number, number, number, number];
  }>;
  openings?: Array<{ kind: "door" | "sliding_door" | "window" | "opening"; at: P; widthM: number }>;
  /** wall segments that are glazing (curtain wall / full-height glass), by two points on the segment */
  glass?: Array<[P, P]>;
  /** room boundaries with no wall (open-plan living, kitchen open to the lounge), by two points on the line */
  openEdges?: Array<[P, P]>;
  /** extra walls not on a room outline */
  walls?: Array<{ a: P; b: P; kind: PlanLevelOut["walls"][number]["kind"]; thicknessM?: number }>;
  furniture?: PlanLevelOut["furniture"];
  dimensionStrings?: string[];
};

const OUTDOOR = /balcony|terrace|garden|pool|deck|outdoor|bbq|lawn|court|sunken/i;

export function sketchToPlan(s: PlanSketch, imgW: number, imgH: number): PlanLevelOut {
  const snap = 5; // px: corners closer than this are the same corner
  const pts: P[] = [];
  const snapPt = (p: P): P => {
    const hit = pts.find((q) => Math.abs(q[0] - p[0]) <= snap && Math.abs(q[1] - p[1]) <= snap);
    if (hit) return hit;
    pts.push(p);
    return p;
  };
  // align near-equal x / y values so shared walls line up exactly
  const xs: number[] = [], ys: number[] = [];
  const alignV = (v: number, arr: number[]) => {
    const hit = arr.find((q) => Math.abs(q - v) <= snap);
    if (hit !== undefined) return hit;
    arr.push(v);
    return v;
  };
  const rooms = s.rooms.map((r) => {
    const raw: P[] = r.poly ?? (r.rect ? [[r.rect[0], r.rect[3]], [r.rect[2], r.rect[3]], [r.rect[2], r.rect[1]], [r.rect[0], r.rect[1]]] : []);
    const poly = raw.map((p) => snapPt([alignV(p[0], xs), alignV(p[1], ys)]));
    return { ...r, poly };
  });

  type Seg = { a: P; b: P; rooms: number[] };
  const segs: Seg[] = [];
  const allPts = rooms.flatMap((r) => r.poly);
  const same = (p: P, q: P) => Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5;
  rooms.forEach((r, ri) => {
    for (let i = 0; i < r.poly.length; i++) {
      const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length];
      const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
      if (L2 < 4) continue;
      // split the edge at every corner lying on it
      const ts = [0, 1];
      for (const v of allPts) {
        const t = ((v[0] - a[0]) * (b[0] - a[0]) + (v[1] - a[1]) * (b[1] - a[1])) / L2;
        const px = a[0] + t * (b[0] - a[0]), py = a[1] + t * (b[1] - a[1]);
        if (t > 0.001 && t < 0.999 && Math.hypot(px - v[0], py - v[1]) < 2) ts.push(t);
      }
      ts.sort((p, q) => p - q);
      for (let k = 0; k < ts.length - 1; k++) {
        if (ts[k + 1] - ts[k] < 1e-4) continue;
        const pa: P = [Math.round(a[0] + ts[k] * (b[0] - a[0])), Math.round(a[1] + ts[k] * (b[1] - a[1]))];
        const pb: P = [Math.round(a[0] + ts[k + 1] * (b[0] - a[0])), Math.round(a[1] + ts[k + 1] * (b[1] - a[1]))];
        const hit = segs.find((sg) => (same(sg.a, pa) && same(sg.b, pb)) || (same(sg.a, pb) && same(sg.b, pa)));
        if (hit) { if (!hit.rooms.includes(ri)) hit.rooms.push(ri); }
        else segs.push({ a: pa, b: pb, rooms: [ri] });
      }
    }
  });

  const outdoor = (ri: number) => OUTDOOR.test(`${rooms[ri].program} ${rooms[ri].name}`);
  const ppm = s.pxPerMeter;
  const walls: PlanLevelOut["walls"] = segs.map((sg) => {
    const shared = sg.rooms.length > 1;
    const anyOut = sg.rooms.some(outdoor), allOut = sg.rooms.every(outdoor);
    let kind: PlanLevelOut["walls"][number]["kind"] = shared ? (anyOut && !allOut ? "glass" : allOut ? "railing" : "interior") : allOut ? "railing" : "exterior";
    // two outdoor areas side by side are open to each other, and open ground areas have no edge walls
    if (shared && allOut) kind = "partition";
    if (!shared && rooms[sg.rooms[0]].open) kind = "partition";
    return { a: { x: sg.a[0], y: sg.a[1] }, b: { x: sg.b[0], y: sg.b[1] }, thickness: (kind === "exterior" ? 0.25 : kind === "railing" ? 0.06 : 0.12) * ppm, kind, openings: [] };
  }).filter((w) => w.kind !== "partition");
  // a derived wall lies on a sketch segment when both its ends do
  const within = (w: (typeof walls)[number], [p, q]: [P, P]) => distToSeg([w.a.x, w.a.y], p, q) <= snap + 1 && distToSeg([w.b.x, w.b.y], p, q) <= snap + 1;
  // outdoor-to-indoor edges are only glass where the sketch says so; elsewhere they are solid exterior walls
  for (const w of walls) {
    const isGlass = (s.glass ?? []).some((g) => within(w, g));
    if (isGlass && w.kind !== "railing") { w.kind = "glass"; w.thickness = 0.15 * ppm; }
    else if (w.kind === "glass") { w.kind = "exterior"; w.thickness = 0.25 * ppm; }
  }
  // open-plan boundaries: rooms that flow into each other with no wall between them
  for (let i = walls.length - 1; i >= 0; i--) if ((s.openEdges ?? []).some((g) => within(walls[i], g))) walls.splice(i, 1);
  for (const w of s.walls ?? []) walls.push({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] }, thickness: (w.thicknessM ?? 0.15) * ppm, kind: w.kind, openings: [] });

  for (const o of s.openings ?? []) {
    let best = -1, bd = Infinity;
    walls.forEach((w, i) => {
      const d = distToSeg(o.at, [w.a.x, w.a.y], [w.b.x, w.b.y]);
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0 || bd > 12) continue;
    const w = walls[best];
    const L2 = (w.b.x - w.a.x) ** 2 + (w.b.y - w.a.y) ** 2;
    const t = ((o.at[0] - w.a.x) * (w.b.x - w.a.x) + (o.at[1] - w.a.y) * (w.b.y - w.a.y)) / L2;
    const L = Math.sqrt(L2);
    const width = Math.min(o.widthM * ppm, L * 0.95);
    w.openings.push({ kind: o.kind, offset: Math.min(1 - width / L / 2, Math.max(width / L / 2, t)), width });
  }

  const nb = (b: [number, number, number, number]) => [b[0] / imgW, b[1] / imgH, b[2] / imgW, b[3] / imgH].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000);
  return {
    levelName: s.levelName,
    units: "pixels",
    scaleConfidence: s.scaleConfidence,
    scaleSource: s.scaleSource,
    pxPerMeter: ppm,
    // origin (0,0 m) sits at (x0, y1): chosen so the anchor lands on its building coordinates
    planBoundsPx: s.anchor
      ? (() => { const x0 = s.anchor!.px[0] - s.anchor!.m[0] * ppm, y1 = s.anchor!.px[1] + s.anchor!.m[1] * ppm; return { x0, y0: y1 - imgH, x1: x0 + imgW, y1 }; })()
      : s.planBoundsPx ?? { x0: 0, y0: 0, x1: imgW, y1: imgH },
    northArrowDeg: s.northArrowDeg ?? null,
    rooms: rooms.map((r) => {
      const xsR = r.poly.map((p) => p[0]), ysR = r.poly.map((p) => p[1]);
      const box: [number, number, number, number] = r.labelBox ?? [Math.min(...xsR), Math.min(...ysR), Math.max(...xsR), Math.max(...ysR)];
      return {
        name: r.name,
        program: r.program,
        polygon: r.poly.map((p) => ({ x: p[0], y: p[1] })),
        printedDimensions: r.printed ?? null,
        printedAreaM2: r.printedAreaM2 ?? null,
        evidence: [{ quote: r.printed ? `${r.name} ${r.printed}` : r.name, bbox: nb(box), confidence: r.printed ? 0.85 : 0.7 }],
      };
    }),
    walls,
    furniture: s.furniture ?? [],
    dimensionStrings: s.dimensionStrings ?? s.rooms.filter((r) => r.printed).map((r) => `${r.name} ${r.printed}`),
  };
}

function distToSeg(p: P, a: P, b: P) {
  const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (!L2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
  return Math.hypot(p[0] - (a[0] + t * (b[0] - a[0])), p[1] - (a[1] + t * (b[1] - a[1])));
}
