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

    // wall ends: corners close without two walls overlapping (see wallEndExtensions)
    const wallExt = wallEndExtensions(level.walls);

    // ── rooms: floor finish, structural slab, ceiling ──
    level.rooms.forEach((r, ri) => {
      if (r.polygon.length < 3) {
        warnings.push(`Room "${r.name}" has fewer than 3 points and was skipped.`);
        return;
      }
      // sub-millimetre step per room: where traced outlines overlap, their faces are never coplanar
      // (coplanar overlapping faces flicker in WebGL and render black in path tracers)
      const lift = (ri % 5) * 0.0006;
      const inferred = isInferred(r.evidence);
      const balcony = /balcony|terrace|garden|deck|pool|outdoor/i.test(r.program + " " + r.name);
      const pool = /\bpool\b/i.test(r.name) && !/pump/i.test(r.name);
      // pools read as water, a hair above the deck so the surface never hides under the ground
      const floorY = (pool ? E - 0.03 : balcony ? E - 0.05 : E) + lift;
      const floorMat = pool ? useMat("__none__", "floor", r, "auto:water") : useMat(undefined, "floor", r, "auto:floor");
      push({ elementId: r.id, elementKind: "floor", levelId: level.id, materialId: floorMat, inferred, shape: { type: "poly", polygon: r.polygon, y: floorY - 0.02, thickness: 0.02 } });
      const slabT = balcony ? 0.18 : 0.25;
      push({ elementId: r.id, elementKind: "slab", levelId: level.id, materialId: useMat(undefined, "facade", undefined, "auto:slab"), inferred: true, shape: { type: "poly", polygon: r.polygon, y: floorY - 0.02 - slabT, thickness: slabT } });

      const ceilingInferred = r.ceilingHeightM === undefined;
      const ceilingH = r.ceilingHeightM ?? level.heightM ?? DEFAULT_CEILING_M;
      if (!balcony) {
        push({ elementId: r.id, elementKind: "ceiling", levelId: level.id, materialId: useMat(undefined, "ceiling", r, "auto:ceiling"), inferred: inferred || ceilingInferred, shape: { type: "poly", polygon: r.polygon, y: E + ceilingH - lift, thickness: 0.05 } });
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
    });

    // ── walls & openings ──
    for (const w of level.walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 0.05) continue;
      const wallInferred = isInferred(w.evidence);
      // each face of a solid wall takes the finish of the room it faces; a face onto the outside (no room, or
      // a terrace / garden / pool) takes the facade finish. Different finishes → two half-thickness leaves.
      const [leftRoom, rightRoom] = roomsBeside(w, level.rooms);
      const faceMat = (r: Room | undefined) => w.materialId ? useMat(w.materialId, "wall", r, "auto:wall")
        : !r || OUTDOOR_RE.test(`${r.program} ${r.name}`) ? useMat(undefined, "facade", undefined, "auto:facade")
        : useMat(undefined, "wall", r, "auto:wall");
      const isGlass = w.kind === "glass";
      const isRail = w.kind === "railing";
      const leftMat = isGlass || isRail ? "" : faceMat(leftRoom);
      const rightMat = isGlass || isRail ? "" : faceMat(rightRoom);
      const wallMat = isGlass || isRail ? useMat(w.materialId, "glass", undefined, "auto:glass") : leftMat;
      /** a solid slice of the wall: one box, or two leaves when its faces have different finishes */
      const solid = (s0: number, e0: number, y0: number, y1: number, kind: ElementKind, elementId: string, inferred: boolean) => {
        if (leftMat === rightMat) {
          push(box(w, s0, e0, y0, y1, T, { elementId, elementKind: kind, levelId: level.id, materialId: leftMat, inferred }, E));
          return;
        }
        push(box(w, s0, e0, y0, y1, T / 2, { elementId, elementKind: kind, levelId: level.id, materialId: leftMat, inferred }, E, T / 4));
        push(box(w, s0, e0, y0, y1, T / 2, { elementId, elementKind: kind, levelId: level.id, materialId: rightMat, inferred }, E, -T / 4));
      };
      const frameMat = useMat(undefined, "joinery", undefined, "auto:frame");
      const H = w.heightM;
      const T = w.thicknessM;
      const [extA, extB] = isGlass || isRail ? [0, 0] : wallExt.get(w.id) ?? [T / 2, T / 2];

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
        const s = s0 === 0 ? -extA : s0;
        const e = e0 === L ? L + extB : e0;
        if (e - s < 0.01) continue;
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
          solid(s, e, 0, H, "wall", w.id, wallInferred);
        }
      }

      for (const { o, s, e } of ops) {
        const inf = isInferred(o.evidence);
        const base = { elementId: o.id, levelId: level.id, inferred: inf };
        const sill = o.kind === "window" ? (o.sillM ?? DEFAULT_WINDOW_SILL_M) : (o.sillM ?? 0);
        if (o.kind === "window" && o.sillM === undefined) warnings.push(`Window ${o.id}: no sill height documented, using ${DEFAULT_WINDOW_SILL_M} m.`);
        const head = Math.min(H, sill + o.heightM);
        const glassMat = useMat(undefined, "glass", undefined, "auto:glass");
        if (isGlass) {
          // in a glazed wall the sill and the transom above a door are glass in a slim frame, not solid panels
          if (sill > 0.01) {
            push(box(w, s, e, 0.05, sill, 0.03, { ...base, elementKind: "glass", materialId: glassMat }));
            push(box(w, s, e, sill - 0.04, sill, 0.08, { ...base, elementKind: "frame", materialId: frameMat }));
          }
          if (head < H - 0.01) {
            push(box(w, s, e, head, H - 0.1, 0.03, { ...base, elementKind: "glass", materialId: glassMat }));
            push(box(w, s, e, head, head + 0.05, 0.08, { ...base, elementKind: "frame", materialId: frameMat }));
          }
        } else if (!isRail) {
          if (sill > 0.01) solid(s, e, 0, sill, "sill", o.id, inf);
          if (head < H - 0.01) solid(s, e, head, H, "lintel", o.id, inf);
        }
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
        if (part.w <= 0.005 || part.d <= 0.005 || part.y1 - part.y0 <= 0.005) continue;
        const matId = part.mat === "joinery" ? useMat(undefined, "joinery", room, "auto:joinery")
          : part.mat === "counter" ? useMat(undefined, "counter", room, "auto:ceramic")
          : part.mat === "ceramic" ? useMat(undefined, "counter", undefined, "auto:ceramic")
          : useMat("__none__", "joinery", undefined, FURNISHING_MAT[part.mat]);
        push({
          elementId: f.id, elementKind: "furniture", levelId: level.id, materialId: matId, inferred: isInferred(f.evidence),
          shape: {
            type: "box",
            center: rot3(f, part.dx, part.dy, E + part.y0 + (part.y1 - part.y0) / 2),
            size: { x: round(part.w), y: round(part.y1 - part.y0), z: round(part.d) },
            rotY: round((f.rotationDeg * Math.PI) / 180 + (part.rot ?? 0), 5),
            ...(part.bevel ? { bevel: part.bevel } : {}),
          },
        });
      }
    }
  }

  // wall tops are drawn as a dark cut line in cut-away views (scene/geometry.ts)
  if (pieces.some((p) => p.elementKind === "wall")) mats.set("auto:cap", FALLBACKS["auto:cap"]);

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
  // start on the level at street level (elevation closest to 0), not in a basement lobby
  const streetLevel = [...levels].sort((a, b) => Math.abs(a.elevationM) - Math.abs(b.elevationM))[0]?.id;
  const onStreet = rooms.filter((r) => r.levelId === streetLevel && r.program !== "balcony");
  const spawnRoom =
    [...onStreet].filter((r) => r.program === "living").sort((a, b) => b.computedAreaM2 - a.computedAreaM2)[0] ??
    onStreet.find((r) => /entr|foyer|lobby|double height/i.test(r.name)) ??
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

const OUTDOOR_RE = /balcony|terrace|garden|deck|pool|outdoor|lawn|court/i;

/** The rooms on the wall's left (+normal) and right (-normal) sides, sampled at a few points along it. */
function roomsBeside(w: Wall, rooms: Room[]): [Room | undefined, Room | undefined] {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const ux = (w.b.x - w.a.x) / L, uy = (w.b.y - w.a.y) / L;
  const nx = -uy, ny = ux;
  const off = w.thicknessM / 2 + 0.12;
  const side = (sg: number) => {
    const votes = new Map<Room, number>();
    for (const t of [0.25, 0.5, 0.75]) {
      const pt = { x: w.a.x + ux * L * t + nx * off * sg, y: w.a.y + uy * L * t + ny * off * sg };
      const r = rooms.find((room) => inPoly(pt, room.polygon));
      if (r) votes.set(r, (votes.get(r) ?? 0) + 1);
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  return [side(1), side(-1)];
}

type Part = {
  dx: number; dy: number; w: number; d: number; y0: number; y1: number;
  mat: "fabric" | "cushion" | "linen" | "throw" | "timber" | "metal" | "joinery" | "counter" | "ceramic";
  bevel?: number; rot?: number;
};
/** Illustrative soft furnishings: shapes and colours are generic, only position and size come from the plan. */
const FURNISHING_MAT: Record<string, string> = {
  fabric: "auto:fabric", cushion: "auto:cushion", linen: "auto:linen", throw: "auto:throw", timber: "auto:timber", metal: "auto:metal",
};

/**
 * Furniture drawn on the plan → simple, recognisable pieces (bed with pillows, sofa with cushions, table with
 * chairs, cabinet fronts). The footprint (w × d, centre, rotation) is the plan's; everything inside it is generic.
 * Local frame: +dy is the piece's back (headboard, sofa back) and sits at the top of the plan when rotation is 0.
 */
function furnitureParts(f: Furniture): Part[] {
  const { w, d, h } = f.sizeM;
  const P: Part[] = [];
  const add = (p: Part) => P.push(p);
  switch (f.kind) {
    case "bed_double":
    case "bed_single": {
      const single = f.kind === "bed_single" || w < 1.3;
      // plans often draw the bedside tables inside the bed's footprint: keep the mattress to a real bed width
      const bw = Math.min(w, single ? 1.1 : 2.0);
      const side = (w - bw) / 2;
      const bd = Math.min(d, 2.2);
      const y = d / 2 - bd / 2; // push the bed against the head wall
      add({ dx: 0, dy: y + bd / 2 - 0.05, w: bw + 0.12, d: 0.1, y0: 0.05, y1: 1.15, mat: "fabric", bevel: 0.03 }); // upholstered headboard
      add({ dx: 0, dy: y - 0.05, w: bw, d: bd - 0.1, y0: 0.08, y1: 0.3, mat: "fabric", bevel: 0.02 }); // base
      add({ dx: 0, dy: y - 0.05, w: bw - 0.08, d: bd - 0.18, y0: 0.08, y1: 0.02 + 0.08, mat: "timber" }); // shadow gap plinth
      add({ dx: 0, dy: y - 0.07, w: bw - 0.04, d: bd - 0.16, y0: 0.3, y1: 0.52, mat: "linen", bevel: 0.05 }); // mattress + sheet
      add({ dx: 0, dy: y - bd / 2 + (bd * 0.62) / 2 + 0.02, w: bw + 0.02, d: bd * 0.62, y0: 0.5, y1: 0.57, mat: "linen", bevel: 0.035 }); // duvet
      add({ dx: 0, dy: y - bd / 2 + 0.3, w: bw + 0.04, d: 0.42, y0: 0.55, y1: 0.59, mat: "throw", bevel: 0.02 }); // throw at the foot
      const n = single ? 1 : 2;
      const pw = (bw - 0.16) / n - 0.04;
      for (let i = 0; i < n; i++) {
        const px = -bw / 2 + 0.1 + pw / 2 + i * (pw + 0.06);
        add({ dx: px, dy: y + bd / 2 - 0.34, w: pw, d: 0.36, y0: 0.52, y1: 0.68, mat: "linen", bevel: 0.07 });
        add({ dx: px, dy: y + bd / 2 - 0.52, w: pw * 0.85, d: 0.12, y0: 0.52, y1: 0.78, mat: "cushion", bevel: 0.05, rot: 0 }); // cushion
      }
      if (side >= 0.35 && !single) {
        for (const sx of [-1, 1]) {
          const cx = sx * (bw / 2 + side / 2);
          add({ dx: cx, dy: y + bd / 2 - 0.3, w: Math.min(0.5, side - 0.05), d: 0.42, y0: 0.0, y1: 0.5, mat: "joinery", bevel: 0.01 });
          add({ dx: cx, dy: y + bd / 2 - 0.3, w: 0.16, d: 0.16, y0: 0.5, y1: 0.8, mat: "linen", bevel: 0.03 }); // lamp
        }
      }
      return P;
    }
    case "sofa":
    case "armchair": {
      const arm = Math.min(0.2, w * 0.18);
      const back = Math.min(0.22, d * 0.3);
      const sh = 0.42, top = Math.max(0.72, Math.min(h, 0.85));
      for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add({ dx: lx * (w / 2 - 0.06), dy: ly * (d / 2 - 0.06), w: 0.04, d: 0.04, y0: 0, y1: 0.08, mat: "timber" });
      add({ dx: 0, dy: 0, w, d, y0: 0.08, y1: 0.3, mat: "fabric", bevel: 0.03 }); // frame
      add({ dx: 0, dy: d / 2 - back / 2, w, d: back, y0: 0.3, y1: top, mat: "fabric", bevel: 0.05 }); // back
      for (const sx of [-1, 1]) add({ dx: sx * (w / 2 - arm / 2), dy: -back / 2 + 0.0, w: arm, d: d - back, y0: 0.3, y1: 0.6, mat: "fabric", bevel: 0.05 });
      const seatW = w - 2 * arm;
      const n = Math.max(1, Math.round(seatW / 0.9));
      const cw = seatW / n;
      for (let i = 0; i < n; i++) {
        const cx = -seatW / 2 + cw * (i + 0.5);
        add({ dx: cx, dy: -back / 2, w: cw - 0.02, d: d - back - 0.02, y0: 0.3, y1: sh + 0.06, mat: "fabric", bevel: 0.06 }); // seat cushion
        add({ dx: cx, dy: d / 2 - back - 0.08, w: cw - 0.04, d: 0.16, y0: sh + 0.04, y1: top - 0.04, mat: "fabric", bevel: 0.07 }); // back cushion
      }
      if (f.kind === "sofa" && seatW > 1.2) {
        add({ dx: -seatW / 2 + 0.3, dy: d / 2 - back - 0.2, w: 0.42, d: 0.12, y0: sh + 0.06, y1: sh + 0.44, mat: "cushion", bevel: 0.06 });
        add({ dx: seatW / 2 - 0.3, dy: d / 2 - back - 0.2, w: 0.42, d: 0.12, y0: sh + 0.06, y1: sh + 0.44, mat: "cushion", bevel: 0.06 });
      }
      return P;
    }
    case "dining": {
      // the plan draws the table; chairs are placed along its long sides (generic)
      const long = Math.max(w, d), short = Math.min(w, d);
      const alongX = w >= d;
      const th = 0.75;
      add({ dx: 0, dy: 0, w, d, y0: th - 0.04, y1: th, mat: "joinery", bevel: 0.008 });
      for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add({ dx: lx * (w / 2 - 0.1), dy: ly * (d / 2 - 0.1), w: 0.06, d: 0.06, y0: 0, y1: th - 0.04, mat: "timber" });
      if (short >= 0.7 && long >= 0.9) {
        const n = Math.max(1, Math.floor((long - 0.1) / 0.62));
        const pitch = long / n;
        for (let i = 0; i < n; i++) {
          const t = -long / 2 + pitch * (i + 0.5);
          for (const sd of [-1, 1]) {
            const off = short / 2 + 0.12;
            const [cx, cy] = alongX ? [t, sd * off] : [sd * off, t];
            const rot = alongX ? (sd > 0 ? 0 : Math.PI) : (sd > 0 ? -Math.PI / 2 : Math.PI / 2);
            P.push(...chair(cx, cy, rot));
          }
        }
        if (long / short > 1.6) {
          for (const sd of [-1, 1]) {
            const off = long / 2 + 0.14;
            const [cx, cy] = alongX ? [sd * off, 0] : [0, sd * off];
            const rot = alongX ? (sd > 0 ? -Math.PI / 2 : Math.PI / 2) : (sd > 0 ? 0 : Math.PI);
            P.push(...chair(cx, cy, rot));
          }
        }
      }
      return P;
    }
    case "desk":
      add({ dx: 0, dy: 0, w, d, y0: h - 0.04, y1: h, mat: "joinery", bevel: 0.006 });
      for (const sx of [-1, 1]) add({ dx: sx * (w / 2 - 0.02), dy: 0, w: 0.04, d: d - 0.02, y0: 0, y1: h - 0.04, mat: "joinery" });
      return P;
    case "kitchen_run":
    case "island": {
      const ch = Math.max(0.86, Math.min(h, 0.95));
      add({ dx: 0, dy: 0.03, w: w - 0.02, d: d - 0.08, y0: 0, y1: 0.1, mat: "timber" }); // recessed plinth
      add({ dx: 0, dy: 0.01, w, d: d - 0.03, y0: 0.1, y1: ch - 0.04, mat: "joinery" }); // carcass
      const n = Math.max(1, Math.round(w / 0.6));
      const fw = w / n;
      for (let i = 0; i < n; i++) {
        // door fronts proud of the carcass with a 3 mm shadow gap between them (both faces of an island)
        for (const sd of f.kind === "island" ? [-1, 1] : [-1]) {
          add({ dx: -w / 2 + fw * (i + 0.5), dy: sd * (d / 2 - 0.01), w: fw - 0.004, d: 0.02, y0: 0.11, y1: ch - 0.05, mat: "joinery", bevel: 0.002 });
          add({ dx: -w / 2 + fw * (i + 0.5), dy: sd * (d / 2 + 0.005), w: Math.min(0.3, fw * 0.5), d: 0.01, y0: ch - 0.12, y1: ch - 0.1, mat: "metal" }); // handle rail
        }
      }
      add({ dx: 0, dy: 0, w: w + 0.02, d: d + 0.02, y0: ch - 0.04, y1: ch, mat: "counter", bevel: 0.004 });
      return P;
    }
    case "wardrobe": {
      const wh = Math.max(2.2, Math.min(h, 2.6));
      add({ dx: 0, dy: 0.01, w, d: d - 0.02, y0: 0, y1: wh, mat: "joinery" });
      const n = Math.max(1, Math.round(w / 0.55));
      const fw = w / n;
      for (let i = 0; i < n; i++) {
        add({ dx: -w / 2 + fw * (i + 0.5), dy: -d / 2 + 0.005, w: fw - 0.004, d: 0.02, y0: 0.02, y1: wh - 0.02, mat: "joinery", bevel: 0.002 });
        const hx = -w / 2 + fw * (i + 0.5) + (i % 2 ? -1 : 1) * (fw / 2 - 0.06);
        add({ dx: hx, dy: -d / 2 - 0.01, w: 0.015, d: 0.015, y0: 0.9, y1: 1.4, mat: "metal" });
      }
      return P;
    }
    case "bath": {
      const bh = 0.55, rim = 0.08;
      add({ dx: 0, dy: 0, w, d, y0: 0, y1: 0.1, mat: "ceramic", bevel: 0.01 });
      add({ dx: 0, dy: -d / 2 + rim / 2, w, d: rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: 0, dy: d / 2 - rim / 2, w, d: rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: -w / 2 + rim / 2, dy: 0, w: rim, d: d - 2 * rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: w / 2 - rim / 2, dy: 0, w: rim, d: d - 2 * rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: w / 2 - rim - 0.05, dy: 0, w: 0.04, d: 0.04, y0: bh, y1: bh + 0.18, mat: "metal" }); // filler
      return P;
    }
    case "wc": {
      const cw = Math.min(w, 0.4), cd = Math.min(d, 0.58);
      add({ dx: 0, dy: d / 2 - 0.09, w: cw, d: 0.16, y0: 0.35, y1: 0.8, mat: "ceramic", bevel: 0.02 }); // cistern
      add({ dx: 0, dy: d / 2 - cd / 2 - 0.05, w: cw * 0.9, d: cd - 0.12, y0: 0.0, y1: 0.4, mat: "ceramic", bevel: 0.06 }); // bowl
      return P;
    }
    case "vanity": {
      add({ dx: 0, dy: 0.02, w, d: d - 0.04, y0: 0.3, y1: 0.8, mat: "joinery", bevel: 0.004 }); // floating unit
      add({ dx: 0, dy: 0, w: w + 0.01, d, y0: 0.8, y1: 0.84, mat: "counter", bevel: 0.004 });
      const n = w >= 1.3 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const cx = n === 1 ? 0 : (i === 0 ? -w / 4 : w / 4);
        add({ dx: cx, dy: -0.03, w: Math.min(0.5, w / n - 0.1), d: Math.min(0.36, d - 0.1), y0: 0.84, y1: 0.97, mat: "ceramic", bevel: 0.04 }); // basin
        add({ dx: cx, dy: d / 2 - 0.06, w: 0.03, d: 0.12, y0: 0.84, y1: 1.08, mat: "metal" }); // tap
      }
      return P;
    }
    default:
      add({ dx: 0, dy: 0, w, d, y0: 0, y1: h, mat: "joinery", bevel: 0.005 });
      return P;
  }
}

/** A dining chair facing the table: rot 0 = the chair sits on +dy of its spot and faces -dy. */
function chair(cx: number, cy: number, rot: number): Part[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  const at = (x: number, y: number) => ({ dx: cx + x * c - y * s, dy: cy + x * s + y * c });
  return [
    { ...at(0, 0), w: 0.46, d: 0.46, y0: 0.42, y1: 0.48, mat: "fabric", bevel: 0.02, rot },
    { ...at(0, 0.2), w: 0.44, d: 0.05, y0: 0.48, y1: 0.88, mat: "fabric", bevel: 0.02, rot },
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([lx, ly]) => ({ ...at(lx * 0.19, ly * 0.19), w: 0.03, d: 0.03, y0: 0, y1: 0.42, mat: "timber" as const, rot })),
  ];
}

/**
 * How far each end of each solid wall runs past its endpoint, so corners and tees close without two walls
 * overlapping (overlapping coplanar faces flicker in WebGL and render as black patches in path tracers).
 * Where wall ends meet, the through wall (one with a straight continuation, else the longest) runs through and
 * the others stop at its face; an end landing on the middle of a wall stops at that wall's face; a free end
 * stops at its point.
 */
function wallEndExtensions(walls: Wall[]): Map<string, [number, number]> {
  const TOL = 0.06;
  const len = (w: Wall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const solid = walls.filter((w) => w.kind !== "glass" && w.kind !== "railing" && len(w) >= 0.05);
  const d2 = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
  const dir = (w: Wall, from: Vec2) => {
    const other = d2(w.a, from) < d2(w.b, from) ? w.b : w.a;
    const L = len(w);
    return { x: (other.x - from.x) / L, y: (other.y - from.y) / L };
  };
  const out = new Map<string, [number, number]>();
  for (const w of solid) {
    const ext: [number, number] = [0, 0];
    (["a", "b"] as const).forEach((end, k) => {
      const p = w[end];
      const meeting = solid.filter((o) => o !== w && (d2(o.a, p) < TOL || d2(o.b, p) < TOL));
      const onMiddle = solid.filter((o) => {
        if (o === w || meeting.includes(o)) return false;
        const L = len(o);
        const t = ((p.x - o.a.x) * (o.b.x - o.a.x) + (p.y - o.a.y) * (o.b.y - o.a.y)) / L;
        if (t <= TOL || t >= L - TOL) return false;
        const dist = Math.abs((p.x - o.a.x) * (o.b.y - o.a.y) - (p.y - o.a.y) * (o.b.x - o.a.x)) / L;
        return dist < o.thicknessM / 2 + 0.02;
      });
      if (onMiddle.length) { ext[k] = -Math.max(...onMiddle.map((o) => o.thicknessM / 2)); return; }
      if (!meeting.length) { ext[k] = 0; return; }
      const group = [w, ...meeting];
      const straight = (x: Wall) => group.some((y) => {
        if (y === x) return false;
        const u = dir(x, p), v = dir(y, p);
        return u.x * v.x + u.y * v.y < -0.98;
      });
      const primary = [...group].sort((x, y) => Number(straight(y)) - Number(straight(x)) || len(y) - len(x) || solid.indexOf(x) - solid.indexOf(y))[0];
      ext[k] = primary === w ? Math.max(...meeting.map((o) => o.thicknessM / 2)) : -primary.thicknessM / 2;
    });
    out.set(w.id, ext);
  }
  return out;
}

function rot3(f: Furniture, dx: number, dy: number, y: number): Vec3 {
  const a = (f.rotationDeg * Math.PI) / 180;
  const x = f.center.x + dx * Math.cos(a) - dy * Math.sin(a);
  const py = f.center.y + dx * Math.sin(a) + dy * Math.cos(a);
  return { x: round(x), y: round(y), z: round(-py) };
}
