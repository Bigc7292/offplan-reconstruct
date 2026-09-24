// Deterministic 3D builder: PropertyDossier → PropertySceneGraph.
// Pure function of the dossier (no clock, no randomness, no model calls), so the
// same dossier always yields byte-identical scene-graph.json.
//
// Plan space (x east, y north, metres) maps to three.js space as (x, elevation, -y).
import crypto from "node:crypto";
import type {
  Furniture, Level, Opening, PropertyDossier, PropertySceneGraph, Room, SceneCollider, SceneMaterial,
  ScenePiece, SceneRoom, Vec2, Vec3, Wall, ElementKind,
} from "./schema";
import { isInferred } from "./schema";
import { labelPoint, polygonArea, polygonCentroid, round } from "./geom";
import { FALLBACKS, resolveMaterial, sceneMaterialFor } from "./materials";
import { levelsForSelection } from "./selection";
export { levelsForSelection };

export const DEFAULT_CEILING_M = 2.85;
const DEFAULT_WINDOW_SILL_M = 0.9;
const DOOR_AJAR_DEG = 25;
const PASSABLE = new Set<Opening["kind"]>(["door", "sliding_door", "opening", "null"]);

export const DISCLAIMER = "Reconstructed from sales materials — not a survey.";

export function dossierHash(d: PropertyDossier): string {
  const { reviewedAt: _r, ...rest } = d;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

export function reconstruct(d: PropertyDossier): PropertySceneGraph {
  const levels = levelsForSelection(d);
  const pieces: ScenePiece[] = [];
  const rooms: SceneRoom[] = [];
  const colliders: SceneCollider[] = [];
  const warnings: string[] = [];
  const mats = new Map<string, SceneMaterial>();
  let openingCount = 0;

  const useMat = (id: string | undefined, surface: Parameters<typeof resolveMaterial>[1], room?: Room, fallback = "auto:wall") => {
    const m = id ? d.materials.find((x) => x.id === id) : resolveMaterial(d, surface, room);
    if (m) {
      if (!mats.has(m.id)) {
        const tex = m.textureAssetId ? d.assets.find((a) => a.id === m.textureAssetId)?.path : undefined;
        mats.set(m.id, sceneMaterialFor(m, tex));
      }
      return m.id;
    }
    if (!mats.has(fallback)) mats.set(fallback, FALLBACKS[fallback]);
    return fallback;
  };

  let pid = 0;
  const push = (p: Omit<ScenePiece, "id">) => pieces.push({ id: `p${pid++}`, ...p });

  for (const level of levels) {
    const E = level.elevationM;
    const roomById = new Map(level.rooms.map((r) => [r.id, r]));

    // ── rooms: floor finish, structural slab, ceiling ──
    for (const r of level.rooms) {
      if (r.polygon.length < 3) {
        warnings.push(`Room "${r.name}" has fewer than 3 points and was skipped.`);
        continue;
      }
      const inferred = isInferred(r.evidence);
      const balcony = /balcony|terrace|garden|deck|pool|outdoor/i.test(r.program + " " + r.name);
      const floorY = balcony ? E - 0.05 : E;
      const floorMat = useMat(undefined, "floor", r, "auto:floor");
      push({ elementId: r.id, elementKind: "floor", levelId: level.id, materialId: floorMat, inferred, shape: { type: "poly", polygon: r.polygon, y: floorY - 0.02, thickness: 0.02 } });
      const slabT = balcony ? 0.18 : 0.25;
      push({ elementId: r.id, elementKind: "slab", levelId: level.id, materialId: useMat(undefined, "facade", undefined, "auto:slab"), inferred: true, shape: { type: "poly", polygon: r.polygon, y: floorY - 0.02 - slabT, thickness: slabT } });

      const ceilingInferred = r.ceilingHeightM === undefined;
      const ceilingH = r.ceilingHeightM ?? level.heightM ?? DEFAULT_CEILING_M;
      if (!balcony) {
        push({ elementId: r.id, elementKind: "ceiling", levelId: level.id, materialId: useMat(undefined, "ceiling", r, "auto:ceiling"), inferred: inferred || ceilingInferred, shape: { type: "poly", polygon: r.polygon, y: E + ceilingH, thickness: 0.05 } });
      }
      const c = polygonCentroid(r.polygon);
      const lp = labelPoint(r.polygon);
      const computed = round(polygonArea(r.polygon), 2);
      rooms.push({
        id: r.id, name: r.name, program: r.program, levelId: level.id,
        centroid: to3(c, E), labelPos: to3(lp, E + 1.4),
        areaM2: r.areaM2 ?? computed, computedAreaM2: computed, documentedAreaM2: r.areaM2,
        ceilingHeightM: ceilingH, ceilingInferred, inferred, floorMaterialId: floorMat,
        polygon: r.polygon.map((p) => ({ x: round(p.x, 3), y: round(p.y, 3) })),
      });
      if (r.areaM2 !== undefined && Math.abs(r.areaM2 - computed) / Math.max(r.areaM2, 1) > 0.12) {
        warnings.push(`${r.name}: documented ${r.areaM2} m² vs traced polygon ${computed} m² (${Math.round(((computed - r.areaM2) / r.areaM2) * 100)}%).`);
      }
    }

    // ── walls & openings ──
    for (const w of level.walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 0.05) continue;
      const wallInferred = isInferred(w.evidence);
      const host = hostRoomFor(w, level.rooms);
      const isGlass = w.kind === "glass";
      const isRail = w.kind === "railing";
      const wallMat = isGlass || isRail ? useMat(w.materialId, "glass", undefined, "auto:glass") : useMat(w.materialId, "wall", host, "auto:wall");
      const frameMat = useMat(undefined, "joinery", undefined, "auto:frame");
      const H = w.heightM;
      const T = w.thicknessM;
      const endExt = isGlass || isRail ? 0 : T / 2;

      const ops = [...w.openings]
        .map((o) => {
          const half = Math.min(o.widthM, L) / 2;
          const c = o.offset * L;
          return { o, s: Math.max(0, c - half), e: Math.min(L, c + half) };
        })
        .sort((x, y) => x.s - y.s);
      openingCount += ops.length;

      // solid intervals between openings
      let cursor = 0;
      const solids: Array<[number, number]> = [];
      for (const { s, e } of ops) {
        if (s > cursor + 1e-3) solids.push([cursor, s]);
        cursor = Math.max(cursor, e);
      }
      if (cursor < L - 1e-3) solids.push([cursor, L]);

      for (const [s0, e0] of solids) {
        const s = s0 === 0 ? -endExt : s0;
        const e = e0 === L ? L + endExt : e0;
        if (isRail) {
          push(box(w, s, e, 0, H - 0.05, T * 0.3, { elementId: w.id, elementKind: "railing", levelId: level.id, materialId: wallMat, inferred: wallInferred }, E));
          push(box(w, s, e, H - 0.05, H, 0.06, { elementId: w.id, elementKind: "handrail", levelId: level.id, materialId: frameMat, inferred: wallInferred }, E));
        } else if (isGlass) {
          push(box(w, s, e, 0.05, H - 0.1, 0.03, { elementId: w.id, elementKind: "glass", levelId: level.id, materialId: wallMat, inferred: wallInferred }, E));
          push(box(w, s, e, 0, 0.05, 0.08, { elementId: w.id, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred: wallInferred }, E));
          push(box(w, s, e, H - 0.1, H, 0.08, { elementId: w.id, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred: wallInferred }, E));
          const n = Math.max(1, Math.round((e - s) / 1.5));
          for (let i = 1; i < n; i++) {
            const m = s + ((e - s) * i) / n;
            push(box(w, m - 0.03, m + 0.03, 0.05, H - 0.1, 0.08, { elementId: w.id, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred: wallInferred }, E));
          }
        } else {
          push(box(w, s, e, 0, H, T, { elementId: w.id, elementKind: "wall", levelId: level.id, materialId: wallMat, inferred: wallInferred }, E));
        }
      }

      for (const { o, s, e } of ops) {
        const inf = isInferred(o.evidence);
        const base = { elementId: o.id, levelId: level.id, inferred: inf };
        const sill = o.kind === "window" ? (o.sillM ?? DEFAULT_WINDOW_SILL_M) : (o.sillM ?? 0);
        if (o.kind === "window" && o.sillM === undefined) warnings.push(`Window ${o.id}: no sill height documented, using ${DEFAULT_WINDOW_SILL_M} m.`);
        const head = Math.min(H, sill + o.heightM);
        const solidMat = isGlass || isRail ? wallMat : wallMat;
        const lintelKind: ElementKind = isGlass ? "frame" : "lintel";
        if (sill > 0.01 && !isRail) push(box(w, s, e, 0, sill, isGlass ? 0.08 : T, { ...base, elementKind: isGlass ? "frame" : "sill", materialId: isGlass ? frameMat : solidMat }));
        if (head < H - 0.01 && !isRail) push(box(w, s, e, head, H, isGlass ? 0.08 : T, { ...base, elementKind: lintelKind, materialId: isGlass ? frameMat : solidMat }));
        const glassMat = useMat(undefined, "glass", undefined, "auto:glass");
        if (o.kind === "window") {
          push(box(w, s, e, sill, head, 0.03, { ...base, elementKind: "glass", materialId: glassMat }));
          push(box(w, s, e, sill, sill + 0.05, Math.max(0.08, T * 0.6), { ...base, elementKind: "frame", materialId: frameMat }));
        } else if (o.kind === "sliding_door") {
          const mid = (s + e) / 2;
          // fixed panel on the first half, sliding panel parked in front of it → second half open
          push(box(w, s, mid, sill, head, 0.03, { ...base, elementKind: "glass", materialId: glassMat }, E, -0.04));
          push(box(w, s + 0.05, mid + 0.05, sill, head, 0.03, { ...base, elementKind: "glass", materialId: glassMat }, E, 0.04));
          push(box(w, s, mid, head - 0.05, head, 0.1, { ...base, elementKind: "frame", materialId: frameMat }));
        } else if (o.kind === "door") {
          pieces.push({ id: `p${pid++}`, ...doorLeaf(w, s, e, sill, head, { ...base, elementKind: "door_leaf", materialId: useMat(undefined, "joinery", undefined, "auto:door") }, E, level.rooms) });
        }
      }

      // walk-mode colliders: everything except passable openings
      const blocks: Array<[number, number]> = [];
      cursor = 0;
      for (const { o, s, e } of ops) {
        if (!PASSABLE.has(o.kind)) continue;
        const [ps, pe] = o.kind === "sliding_door" ? [(s + e) / 2, e] : [s, e];
        if (ps > cursor) blocks.push([cursor, ps]);
        cursor = Math.max(cursor, pe);
      }
      if (cursor < L) blocks.push([cursor, L]);
      for (const [s, e] of blocks) {
        colliders.push({ levelId: level.id, a: along(w, s), b: along(w, e), halfThickness: Math.max(T / 2, 0.05) });
      }
    }

    // ── furniture proxies (only when the dossier lists them) ──
    for (const f of level.furniture ?? []) {
      const room = f.roomId ? roomById.get(f.roomId) : undefined;
      for (const part of furnitureParts(f)) {
        const matId = part.mat === "joinery" ? useMat(undefined, "joinery", room, "auto:joinery")
          : part.mat === "counter" ? useMat(undefined, "counter", room, "auto:ceramic")
          : part.mat === "ceramic" ? useMat(undefined, "counter", undefined, "auto:ceramic")
          : useMat("__none__", "joinery", undefined, "auto:fabric");
        push({
          elementId: f.id, elementKind: "furniture", levelId: level.id, materialId: matId, inferred: isInferred(f.evidence),
          shape: {
            type: "box",
            center: rot3(f, part.dx, part.dy, E + part.y0 + (part.y1 - part.y0) / 2),
            size: { x: part.w, y: part.y1 - part.y0, z: part.d },
            rotY: (f.rotationDeg * Math.PI) / 180,
          },
        });
      }
    }
  }

  // bounds
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pieces) {
    if (p.shape.type === "box") {
      const { center: c, size: s, rotY } = p.shape;
      const cos = Math.cos(rotY), sin = Math.sin(rotY);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = (lx * s.x) / 2, z = (lz * s.z) / 2;
        ext(min, max, c.x + x * cos + z * sin, c.y - s.y / 2, c.z - x * sin + z * cos);
        ext(min, max, c.x + x * cos + z * sin, c.y + s.y / 2, c.z - x * sin + z * cos);
      }
    } else {
      for (const v of p.shape.polygon) ext(min, max, v.x, p.shape.y, -v.y), ext(min, max, v.x, p.shape.y + p.shape.thickness, -v.y);
    }
  }
  if (!isFinite(min.x)) { min.x = min.y = min.z = 0; max.x = max.y = max.z = 1; }

  // spawn in the entrance if there is one, else the largest living space
  const spawnRoom =
    rooms.find((r) => /entr|foyer|lobby/i.test(r.name)) ??
    [...rooms].filter((r) => r.program === "living").sort((a, b) => b.computedAreaM2 - a.computedAreaM2)[0] ??
    rooms[0];
  const living = rooms.find((r) => r.program === "living" && r.id !== spawnRoom?.id);
  const yawDeg = spawnRoom && living ? (Math.atan2(-(living.centroid.x - spawnRoom.centroid.x), -(living.centroid.z - spawnRoom.centroid.z)) * 180) / Math.PI : 0;

  const inferredPieces = pieces.filter((p) => p.inferred && p.elementKind !== "slab").length;
  return {
    version: 1,
    jobId: d.jobId,
    dossierHash: dossierHash(d),
    demo: !!d.demo,
    unitTypeId: d.selectedUnitTypeId,
    title: [d.projectName, d.unitTypes.find((u) => u.id === d.selectedUnitTypeId)?.code].filter(Boolean).join(" · ") || "Untitled property",
    disclaimer: DISCLAIMER,
    northDeg: d.northDeg,
    levels: levels.map((l) => ({ id: l.id, name: l.name, elevationM: l.elevationM, heightM: l.heightM })),
    materials: [...mats.values()].sort((a, b) => a.id.localeCompare(b.id)),
    pieces,
    rooms,
    colliders,
    bounds: { min: r3(min), max: r3(max) },
    spawn: {
      levelId: spawnRoom?.levelId ?? levels[0]?.id ?? "",
      position: spawnRoom ? { x: spawnRoom.centroid.x, y: spawnRoom.centroid.y + 1.6, z: spawnRoom.centroid.z } : { x: 0, y: 1.6, z: 0 },
      yawDeg: round(yawDeg, 2),
    },
    stats: {
      walls: levels.reduce((n, l) => n + l.walls.length, 0),
      openings: openingCount,
      rooms: rooms.length,
      inferredPieces,
      attestedPieces: pieces.length - inferredPieces,
    },
    warnings: [...new Set(warnings)],
  };
}

// ───────────────────────── helpers ─────────────────────────

function to3(p: Vec2, y: number): Vec3 {
  return { x: round(p.x), y: round(y), z: round(-p.y) };
}
function r3(v: Vec3): Vec3 {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}
function ext(min: Vec3, max: Vec3, x: number, y: number, z: number) {
  min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
  max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
}

function along(w: Wall, t: number): Vec2 {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  return { x: round(w.a.x + ((w.b.x - w.a.x) * t) / L), y: round(w.a.y + ((w.b.y - w.a.y) * t) / L) };
}

/** Box spanning [s,e] metres along the wall, [y0,y1] above the level, `thick` across. */
function box(
  w: Wall, s: number, e: number, y0: number, y1: number, thick: number,
  rest: Omit<ScenePiece, "id" | "shape">, E = 0, normalShift = 0,
): Omit<ScenePiece, "id"> {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const ux = (w.b.x - w.a.x) / L, uy = (w.b.y - w.a.y) / L;
  const mid = (s + e) / 2;
  const px = w.a.x + ux * mid - uy * normalShift;
  const py = w.a.y + uy * mid + ux * normalShift;
  return {
    ...rest,
    shape: {
      type: "box",
      center: { x: round(px), y: round(E + (y0 + y1) / 2), z: round(-py) },
      size: { x: round(e - s), y: round(y1 - y0), z: round(thick) },
      rotY: round(Math.atan2(uy, ux), 5),
    },
  };
}

/** Door leaf hinged at the start of the opening, swung DOOR_AJAR_DEG into the adjoining room. */
function doorLeaf(
  w: Wall, s: number, e: number, y0: number, y1: number, rest: Omit<ScenePiece, "id" | "shape">, E: number, rooms: Room[],
): Omit<ScenePiece, "id"> {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const ux = (w.b.x - w.a.x) / L, uy = (w.b.y - w.a.y) / L;
  const nx = -uy, ny = ux; // left normal
  const width = e - s;
  // swing to whichever side has a room (prefer the smaller room, as doors usually open inward)
  const hinge = { x: w.a.x + ux * s, y: w.a.y + uy * s };
  const probe = (side: number) => {
    const pt = { x: hinge.x + ux * width * 0.5 + nx * 0.4 * side, y: hinge.y + uy * width * 0.5 + ny * 0.4 * side };
    const r = rooms.find((room) => inPoly(pt, room.polygon));
    return r ? polygonArea(r.polygon) : Infinity;
  };
  const side = probe(1) <= probe(-1) ? 1 : -1;
  const ang = Math.atan2(uy, ux) + side * ((DOOR_AJAR_DEG * Math.PI) / 180);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const cx = hinge.x + dx * (width / 2) + nx * side * 0.02;
  const cy = hinge.y + dy * (width / 2) + ny * side * 0.02;
  return {
    ...rest,
    shape: { type: "box", center: { x: round(cx), y: round(E + (y0 + y1) / 2), z: round(-cy) }, size: { x: round(width - 0.02), y: round(y1 - y0 - 0.01), z: 0.04 }, rotY: round(ang, 5) },
  };
}

function inPoly(pt: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The room a wall mostly faces (used to pick room-bound wall finishes, e.g. bathroom stone). */
function hostRoomFor(w: Wall, rooms: Room[]): Room | undefined {
  const mx = (w.a.x + w.b.x) / 2, my = (w.a.y + w.b.y) / 2;
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const nx = -(w.b.y - w.a.y) / L, ny = (w.b.x - w.a.x) / L;
  const sides = [1, -1].map((s) => rooms.find((r) => inPoly({ x: mx + nx * 0.3 * s, y: my + ny * 0.3 * s }, r.polygon)));
  // prefer a wet room so its stone lines the shared wall
  return sides.find((r) => r?.program === "bath") ?? sides.find(Boolean);
}

type Part = { dx: number; dy: number; w: number; d: number; y0: number; y1: number; mat: "fabric" | "joinery" | "counter" | "ceramic" };
function furnitureParts(f: Furniture): Part[] {
  const { w, d, h } = f.sizeM;
  switch (f.kind) {
    case "bed_double":
    case "bed_single":
      return [
        { dx: 0, dy: 0, w, d, y0: 0, y1: h, mat: "fabric" },
        { dx: 0, dy: d / 2 - 0.05, w, d: 0.1, y0: 0, y1: 1.1, mat: "joinery" }, // headboard on the far (+y) side
      ];
    case "sofa":
    case "armchair":
      return [
        { dx: 0, dy: 0, w, d, y0: 0, y1: 0.42, mat: "fabric" },
        { dx: 0, dy: d / 2 - 0.1, w, d: 0.2, y0: 0.42, y1: h, mat: "fabric" },
      ];
    case "dining":
    case "desk":
      return [
        { dx: 0, dy: 0, w, d, y0: h - 0.04, y1: h, mat: "joinery" },
        { dx: 0, dy: 0, w: Math.min(0.12, w), d: Math.min(0.12, d), y0: 0, y1: h - 0.04, mat: "joinery" },
      ];
    case "kitchen_run":
    case "island":
      return [
        { dx: 0, dy: 0, w, d, y0: 0.1, y1: h - 0.04, mat: "joinery" },
        { dx: 0, dy: 0, w: w + 0.02, d: d + 0.02, y0: h - 0.04, y1: h, mat: "counter" },
      ];
    case "wardrobe":
      return [{ dx: 0, dy: 0, w, d, y0: 0, y1: h, mat: "joinery" }];
    case "bath":
    case "wc":
    case "vanity":
      return [{ dx: 0, dy: 0, w, d, y0: 0, y1: h, mat: "ceramic" }];
    default:
      return [{ dx: 0, dy: 0, w, d, y0: 0, y1: h, mat: "joinery" }];
  }
}

function rot3(f: Furniture, dx: number, dy: number, y: number): Vec3 {
  const a = (f.rotationDeg * Math.PI) / 180;
  const x = f.center.x + dx * Math.cos(a) - dy * Math.sin(a);
  const py = f.center.y + dx * Math.sin(a) + dy * Math.cos(a);
  return { x: round(x), y: round(y), z: round(-py) };
}
