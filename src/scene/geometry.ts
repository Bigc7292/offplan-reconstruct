// Scene graph → triangle buffers. Shared by the browser viewer and the server GLB
// exporter so what you walk through is exactly what you export.
import { ShapeUtils, Vector2 } from "three";
import type { PropertySceneGraph, ScenePiece } from "@/lib/schema";

export type TriBuffers = {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  /** triangle index → piece index in the scene graph (for picking) */
  triPiece: number[];
};

export type MeshGroup = {
  key: string;
  levelId: string;
  materialId: string;
  layer: "ceiling" | "glass" | "main";
  inferred: boolean;
  buffers: TriBuffers;
};

const empty = (): TriBuffers => ({ positions: [], normals: [], uvs: [], indices: [], triPiece: [] });

function addQuad(b: TriBuffers, pts: number[][], n: number[], uv: number[][], piece: number) {
  const base = b.positions.length / 3;
  for (let i = 0; i < 4; i++) {
    b.positions.push(pts[i][0], pts[i][1], pts[i][2]);
    b.normals.push(n[0], n[1], n[2]);
    b.uvs.push(uv[i][0], uv[i][1]);
  }
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  b.triPiece.push(piece, piece);
}

/** Solid wall parts whose top face is drawn as the dark cut line of a section. */
const CAPPED = new Set(["wall", "lintel", "sill"]);
export const CAP_MATERIAL = "auto:cap";

/** local → world for a box: tilt about x by `pitch`, rotate about Y by rotY (three.js convention), then translate */
function boxFrame(c: { x: number; y: number; z: number }, rotY: number, pitch = 0) {
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const rn = (x: number, y: number, z: number) => {
    const y1 = y * cp - z * sp, z1 = y * sp + z * cp;
    return [x * cos + z1 * sin, y1, -x * sin + z1 * cos];
  };
  const tr = (x: number, y: number, z: number) => { const r = rn(x, y, z); return [c.x + r[0], c.y + r[1], c.z + r[2]]; };
  return { tr, rn };
}

function addBox(b: TriBuffers, p: ScenePiece, pieceIdx: number, cap?: TriBuffers) {
  if (p.shape.type !== "box") return;
  const { center: c, size: s, rotY } = p.shape;
  const { tr, rn } = boxFrame(c, rotY, p.shape.pitch);
  const hx = s.x / 2, hy = s.y / 2, hz = s.z / 2;
  // world-scale UVs (1 unit = 1 m) so textures tile at real size
  const faces: Array<{ n: number[]; v: number[][]; uv: number[][] }> = [
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], uv: [[0, 0], [s.z, 0], [s.z, s.y], [0, s.y]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], uv: [[0, 0], [s.z, 0], [s.z, s.y], [0, s.y]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], uv: [[0, 0], [s.x, 0], [s.x, s.z], [0, s.z]] },
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], uv: [[0, 0], [s.x, 0], [s.x, s.z], [0, s.z]] },
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], uv: [[0, 0], [s.x, 0], [s.x, s.y], [0, s.y]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], uv: [[0, 0], [s.x, 0], [s.x, s.y], [0, s.y]] },
  ];
  for (const f of faces) addQuad(cap && f.n[1] === 1 ? cap : b, f.v.map((v) => tr(v[0], v[1], v[2])), rn(f.n[0], f.n[1], f.n[2]), f.uv, pieceIdx);
}

/** Box with every edge chamfered by `c` (6 inset faces, 12 edge strips, 8 corner triangles). */
function addChamferBox(b: TriBuffers, p: ScenePiece, pieceIdx: number) {
  if (p.shape.type !== "box") return;
  const { center: ctr, size: s, rotY } = p.shape;
  const hx = s.x / 2, hy = s.y / 2, hz = s.z / 2;
  const c = Math.min(p.shape.bevel ?? 0, hx * 0.9, hy * 0.9, hz * 0.9);
  const frame = boxFrame(ctr, rotY, p.shape.pitch);
  const tr = (v: number[]) => frame.tr(v[0], v[1], v[2]);
  const rn = (n: number[]) => {
    const L = Math.hypot(n[0], n[1], n[2]) || 1;
    return frame.rn(n[0] / L, n[1] / L, n[2] / L);
  };
  // the three points of corner (sx, sy, sz) lying on its x-, y- and z-faces
  const P = (axis: 0 | 1 | 2, sx: number, sy: number, sz: number) =>
    axis === 0 ? [sx * hx, sy * (hy - c), sz * (hz - c)] : axis === 1 ? [sx * (hx - c), sy * hy, sz * (hz - c)] : [sx * (hx - c), sy * (hy - c), sz * hz];
  const face = (pts: number[][], n: number[]) => {
    // wind counter-clockwise seen from outside
    const e1 = pts[1].map((v, i) => v - pts[0][i]), e2 = pts[2].map((v, i) => v - pts[0][i]);
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) pts = [...pts].reverse();
    // world-scale planar UVs on the two axes the face is least aligned with
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const [u, v] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
    const base = b.positions.length / 3;
    const wn = rn(n);
    for (const q of pts) {
      const w = tr(q);
      b.positions.push(w[0], w[1], w[2]);
      b.normals.push(wn[0], wn[1], wn[2]);
      b.uvs.push(q[u] + [hx, hy, hz][u], q[v] + [hx, hy, hz][v]);
    }
    for (let i = 1; i < pts.length - 1; i++) { b.indices.push(base, base + i, base + i + 1); b.triPiece.push(pieceIdx); }
  };
  const S = [-1, 1];
  for (const sx of S) face([P(0, sx, -1, -1), P(0, sx, 1, -1), P(0, sx, 1, 1), P(0, sx, -1, 1)], [sx, 0, 0]);
  for (const sy of S) face([P(1, -1, sy, -1), P(1, 1, sy, -1), P(1, 1, sy, 1), P(1, -1, sy, 1)], [0, sy, 0]);
  for (const sz of S) face([P(2, -1, -1, sz), P(2, 1, -1, sz), P(2, 1, 1, sz), P(2, -1, 1, sz)], [0, 0, sz]);
  if (c <= 1e-4) return;
  for (const sx of S) for (const sy of S) face([P(0, sx, sy, -1), P(0, sx, sy, 1), P(1, sx, sy, 1), P(1, sx, sy, -1)], [sx, sy, 0]);
  for (const sx of S) for (const sz of S) face([P(0, sx, -1, sz), P(0, sx, 1, sz), P(2, sx, 1, sz), P(2, sx, -1, sz)], [sx, 0, sz]);
  for (const sy of S) for (const sz of S) face([P(1, -1, sy, sz), P(1, 1, sy, sz), P(2, 1, sy, sz), P(2, -1, sy, sz)], [0, sy, sz]);
  for (const sx of S) for (const sy of S) for (const sz of S) face([P(0, sx, sy, sz), P(1, sx, sy, sz), P(2, sx, sy, sz)], [sx, sy, sz]);
}

function addPoly(b: TriBuffers, p: ScenePiece, pieceIdx: number) {
  if (p.shape.type !== "poly") return;
  const { polygon, y, thickness } = p.shape;
  let pts = polygon.map((v) => new Vector2(v.x, v.y));
  if (ShapeUtils.isClockWise(pts)) pts = pts.reverse();
  // holes run clockwise (their sides then face into the hole)
  const holes = (p.shape.holes ?? []).filter((h) => h.length >= 3).map((h) => {
    const hp = h.map((v) => new Vector2(v.x, v.y));
    return ShapeUtils.isClockWise(hp) ? hp : hp.reverse();
  });
  const tris = ShapeUtils.triangulateShape(pts, holes);
  const all = [...pts, ...holes.flat()];
  const top = y + thickness;
  // top face (plan y → world -z; CCW in plan = CCW seen from above)
  const baseTop = b.positions.length / 3;
  for (const v of all) { b.positions.push(v.x, top, -v.y); b.normals.push(0, 1, 0); b.uvs.push(v.x, v.y); }
  for (const t of tris) { b.indices.push(baseTop + t[0], baseTop + t[1], baseTop + t[2]); b.triPiece.push(pieceIdx); }
  // bottom face
  const baseBot = b.positions.length / 3;
  for (const v of all) { b.positions.push(v.x, y, -v.y); b.normals.push(0, -1, 0); b.uvs.push(v.x, v.y); }
  for (const t of tris) { b.indices.push(baseBot + t[0], baseBot + t[2], baseBot + t[1]); b.triPiece.push(pieceIdx); }
  // sides
  if (thickness > 0.001) {
    for (const loop of [pts, ...holes]) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], c = loop[(i + 1) % loop.length];
        const L = Math.hypot(c.x - a.x, c.y - a.y) || 1;
        const n = [(c.y - a.y) / L, 0, (c.x - a.x) / L]; // outward normal of CCW edge, in world xz
        addQuad(b, [[a.x, y, -a.y], [c.x, y, -c.y], [c.x, top, -c.y], [a.x, top, -a.y]], n, [[0, 0], [L, 0], [L, thickness], [0, thickness]], pieceIdx);
      }
    }
  }
}

export function layerOf(p: ScenePiece): MeshGroup["layer"] {
  // roofs and ceiling fittings go with the ceilings: cut-away views hide them together
  if (p.elementKind === "ceiling" || p.elementKind === "roof" || p.elementKind === "light") return "ceiling";
  if (p.elementKind === "glass" || p.elementKind === "railing") return "glass";
  return "main";
}

/** Architecture that a section cut trims to the cut height; furniture, floors and the site stay whole. */
const CUT_KINDS = new Set(["wall", "lintel", "sill", "glass", "frame", "door_leaf", "fascia", "screen", "curtain"]);

/** A storey drawn as a section: its walls stop at `y` (world height), capped with the cut-line colour. */
export type SectionCut = { levelId: string; y: number };

function cutPiece(p: ScenePiece, cut?: SectionCut): ScenePiece | null {
  if (!cut || p.levelId !== cut.levelId || p.shape.type !== "box" || !CUT_KINDS.has(p.elementKind) || p.shape.pitch) return p;
  const { center: c, size: s } = p.shape;
  const y0 = c.y - s.y / 2, y1 = c.y + s.y / 2;
  if (y0 >= cut.y - 0.005) return null;
  if (y1 <= cut.y) return p;
  return { ...p, shape: { ...p.shape, center: { ...c, y: (y0 + cut.y) / 2 }, size: { ...s, y: cut.y - y0 } } };
}

/** Merge pieces into one buffer per (level, material, layer, inferred) so a whole unit is a handful of draw calls. */
export function buildGroups(g: PropertySceneGraph, cut?: SectionCut): MeshGroup[] {
  const groups = new Map<string, MeshGroup>();
  const group = (levelId: string, materialId: string, layer: MeshGroup["layer"], inferred: boolean) => {
    const key = `${levelId}|${materialId}|${layer}|${inferred ? 1 : 0}`;
    let grp = groups.get(key);
    if (!grp) {
      grp = { key, levelId, materialId, layer, inferred, buffers: empty() };
      groups.set(key, grp);
    }
    return grp;
  };
  const caps = g.materials.some((m) => m.id === CAP_MATERIAL);
  g.pieces.forEach((p0, i) => {
    const p = cutPiece(p0, cut);
    if (!p) return;
    const grp = group(p.levelId, p.materialId, layerOf(p), p.inferred);
    if (p.shape.type === "box" && p.shape.bevel) addChamferBox(grp.buffers, p, i);
    else if (p.shape.type === "box") addBox(grp.buffers, p, i, caps && (CAPPED.has(p.elementKind) || (p !== p0 && CUT_KINDS.has(p.elementKind))) ? group(p.levelId, CAP_MATERIAL, "main", p.inferred).buffers : undefined);
    else addPoly(grp.buffers, p, i);
  });
  return [...groups.values()].filter((grp) => grp.buffers.indices.length);
}

/** Triangles for a single piece (used for selection highlight overlays). */
export function pieceBuffers(g: PropertySceneGraph, pieceIdxs: number[]): TriBuffers {
  const b = empty();
  for (const i of pieceIdxs) {
    const p = g.pieces[i];
    if (p.shape.type === "box") (p.shape.bevel ? addChamferBox : addBox)(b, p, i);
    else addPoly(b, p, i);
  }
  return b;
}
