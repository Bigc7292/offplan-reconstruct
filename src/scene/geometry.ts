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

function addBox(b: TriBuffers, p: ScenePiece, pieceIdx: number) {
  if (p.shape.type !== "box") return;
  const { center: c, size: s, rotY } = p.shape;
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  // local → world: rotate about Y by rotY (three.js convention), then translate
  const tr = (x: number, y: number, z: number) => [c.x + x * cos + z * sin, c.y + y, c.z - x * sin + z * cos];
  const rn = (x: number, y: number, z: number) => [x * cos + z * sin, y, -x * sin + z * cos];
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
  for (const f of faces) addQuad(b, f.v.map((v) => tr(v[0], v[1], v[2])), rn(f.n[0], f.n[1], f.n[2]), f.uv, pieceIdx);
}

function addPoly(b: TriBuffers, p: ScenePiece, pieceIdx: number) {
  if (p.shape.type !== "poly") return;
  const { polygon, y, thickness } = p.shape;
  let pts = polygon.map((v) => new Vector2(v.x, v.y));
  if (ShapeUtils.isClockWise(pts)) pts = pts.reverse();
  const tris = ShapeUtils.triangulateShape(pts, []);
  const top = y + thickness;
  // top face (plan y → world -z; CCW in plan = CCW seen from above)
  const baseTop = b.positions.length / 3;
  for (const v of pts) { b.positions.push(v.x, top, -v.y); b.normals.push(0, 1, 0); b.uvs.push(v.x, v.y); }
  for (const t of tris) { b.indices.push(baseTop + t[0], baseTop + t[1], baseTop + t[2]); b.triPiece.push(pieceIdx); }
  // bottom face
  const baseBot = b.positions.length / 3;
  for (const v of pts) { b.positions.push(v.x, y, -v.y); b.normals.push(0, -1, 0); b.uvs.push(v.x, v.y); }
  for (const t of tris) { b.indices.push(baseBot + t[0], baseBot + t[2], baseBot + t[1]); b.triPiece.push(pieceIdx); }
  // sides
  if (thickness > 0.001) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const L = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      const n = [(c.y - a.y) / L, 0, (c.x - a.x) / L]; // outward normal of CCW edge, in world xz
      addQuad(b, [[a.x, y, -a.y], [c.x, y, -c.y], [c.x, top, -c.y], [a.x, top, -a.y]], n, [[0, 0], [L, 0], [L, thickness], [0, thickness]], pieceIdx);
    }
  }
}

export function layerOf(p: ScenePiece): MeshGroup["layer"] {
  if (p.elementKind === "ceiling") return "ceiling";
  if (p.elementKind === "glass" || p.elementKind === "railing") return "glass";
  return "main";
}

/** Merge pieces into one buffer per (level, material, layer, inferred) so a whole unit is a handful of draw calls. */
export function buildGroups(g: PropertySceneGraph): MeshGroup[] {
  const groups = new Map<string, MeshGroup>();
  g.pieces.forEach((p, i) => {
    const layer = layerOf(p);
    const key = `${p.levelId}|${p.materialId}|${layer}|${p.inferred ? 1 : 0}`;
    let grp = groups.get(key);
    if (!grp) {
      grp = { key, levelId: p.levelId, materialId: p.materialId, layer, inferred: p.inferred, buffers: empty() };
      groups.set(key, grp);
    }
    if (p.shape.type === "box") addBox(grp.buffers, p, i);
    else addPoly(grp.buffers, p, i);
  });
  return [...groups.values()];
}

/** Triangles for a single piece (used for selection highlight overlays). */
export function pieceBuffers(g: PropertySceneGraph, pieceIdxs: number[]): TriBuffers {
  const b = empty();
  for (const i of pieceIdxs) {
    const p = g.pieces[i];
    if (p.shape.type === "box") addBox(b, p, i);
    else addPoly(b, p, i);
  }
  return b;
}
