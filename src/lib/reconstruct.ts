// Deterministic 3D builder: PropertyDossier → PropertySceneGraph.
// Pure function of the dossier (no clock, no randomness, no model calls), so the
// same dossier always yields byte-identical scene-graph.json.
//
// Plan space (x east, y north, metres) maps to three.js space as (x, elevation, -y).
//
// What the plans draw (rooms, walls, openings, furniture) is built as drawn. Around it the builder adds what a
// buyer expects to see and the plans only imply, all marked inferred: floor plates and roofs with their slab
// edges, stairs, pools, parking bays, the plot with its paving and planting (structure.ts), and illustrative
// furniture, curtains and light fittings that dress each room (staging.ts, furniture.ts).
import crypto from "node:crypto";
import type {
  Level, Opening, PropertyDossier, PropertySceneGraph, Room, SceneCollider, SceneMaterial,
  ScenePiece, SceneRoom, Vec2, Vec3, Wall, ElementKind, Surface,
} from "./schema";
import { isInferred } from "./schema";
import { labelPoint, polygonArea, polygonCentroid, pointInPolygon, round } from "./geom";
import { FALLBACKS, ROLE_OF, resolveMaterial, sceneMaterialFor } from "./materials";
import { levelsForSelection } from "./selection";
import { roomKind, stageLevel, type RoomKind } from "./staging";
import { circle, furnitureHeight, furnitureParts, LIGHT_KINDS, type FurnitureLike, type PartMat } from "./furniture";
import { rasterize, offsetGrid, subtract, outlines, bboxOf as bboxOfPolys } from "./footprint";
import {
  emitParking, emitPlates, emitPool, emitRamp, emitSite, emitStair, emitSunken, isOutdoor, stairPlans, storeys,
  PLATE_TOP, type Emit, type Storey,
} from "./structure";
export { levelsForSelection };

export const DEFAULT_CEILING_M = 2.85;
const DEFAULT_WINDOW_SILL_M = 0.9;
const DOOR_AJAR_DEG = 25;
const PASSABLE = new Set<Opening["kind"]>(["door", "sliding_door", "opening", "null"]);
const FRAME_W = 0.05; // visible width of a window / door frame member

export const DISCLAIMER = "Reconstructed from sales materials — not a survey.";

/** Rooms named for a program the plan reader left generic still take that program's finishes. */
const KIND_PROGRAM: Partial<Record<RoomKind, string>> = {
  living: "living", dining: "living", kitchen: "kitchen", bedroom: "bedroom", bath: "bath", closet: "bedroom", circulation: "circulation",
};
const LIT_KINDS = new Set<RoomKind>(["living", "dining", "kitchen", "bedroom", "staff", "bath", "closet", "circulation", "garage", "other"]);
const COVE_KINDS = new Set<RoomKind>(["living", "dining", "bedroom", "circulation"]);

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

  const auto = (id: string) => {
    const key = FALLBACKS[id] ? id : "auto:concrete";
    if (!mats.has(key)) mats.set(key, FALLBACKS[key]);
    return key;
  };
  const addMat = (m: PropertyDossier["materials"][number]) => {
    if (!mats.has(m.id)) {
      const tex = m.textureAssetId ? d.assets.find((a) => a.id === m.textureAssetId)?.path : undefined;
      mats.set(m.id, sceneMaterialFor(m, tex));
    }
    return m.id;
  };
  /** the documented finish for a surface of a room (room, then its program, then what its name says it is), else a named default */
  const useMat = (surface: Surface, room: Room | undefined, fallback: string) => {
    let m = resolveMaterial(d, surface, room);
    if (!m && room) {
      const kind = roomKind(room);
      const prog = KIND_PROGRAM[kind];
      // staff and service rooms keep plain finishes rather than borrowing the principal rooms'
      if (prog && prog !== room.program) m = resolveMaterial(d, surface, { ...room, program: prog });
    }
    return m ? addMat(m) : auto(fallback);
  };
  const byId = (id: string, fallback: string) => {
    const m = d.materials.find((x) => x.id === id);
    return m ? addMat(m) : auto(fallback);
  };
  /** an exterior finish read off the renders for this role, else a named default */
  const roleMat = (role: string) => {
    const r = ROLE_OF[role];
    const m = r ? d.materials.find((x) => x.role === r) : undefined;
    if (m) return addMat(m);
    if (role === "facade") return useMat("facade", undefined, "auto:facade");
    if (role === "glass") return useMat("glass", undefined, "auto:glass");
    return auto(`auto:${role}`);
  };

  let pid = 0;
  const push = (p: Omit<ScenePiece, "id">) => { pieces.push({ id: `p${pid++}`, ...p }); };
  const e: Emit = { push, mat: roleMat };

  const st = storeys(levels, (l) => l.heightM ?? DEFAULT_CEILING_M);
  const stairs = stairPlans(st);
  // voids in the plate above: stair wells (less the landing the stair arrives on) and double-height rooms
  const voids = new Map<string, Vec2[][]>();
  const addVoid = (levelId: string | undefined, poly: Vec2[]) => { if (levelId) voids.set(levelId, [...(voids.get(levelId) ?? []), poly]); };
  const stairRooms = new Set<string>();
  for (const s of st) {
    for (const plan of stairs.get(s.level.id) ?? []) {
      const b = bboxOfPolys([plan.path]);
      const h = plan.width / 2;
      let x0 = b.minX - h, x1 = b.maxX + h, y0 = b.minY - h, y1 = b.maxY + h;
      if (plan.landing.length) {
        const l = bboxOfPolys([plan.landing]);
        if (l.minY <= y0 + 0.01 && l.maxY < y1 - 0.01 && l.maxX - l.minX > (x1 - x0) * 0.9) y0 = l.maxY;
        else if (l.maxY >= y1 - 0.01 && l.minY > y0 + 0.01 && l.maxX - l.minX > (x1 - x0) * 0.9) y1 = l.minY;
        else if (l.minX <= x0 + 0.01 && l.maxX < x1 - 0.01) x0 = l.maxX;
        else if (l.maxX >= x1 - 0.01 && l.minX > x0 + 0.01) x1 = l.minX;
      }
      addVoid(s.above?.level.id, [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
      for (const r of s.level.rooms) if (/\bstair/i.test(r.name) && r.polygon.length >= 3 && pointInPolygon(polygonCentroid(r.polygon), [{ x: x0, y: b.minY - h }, { x: x1, y: b.minY - h }, { x: x1, y: b.maxY + h }, { x: x0, y: b.maxY + h }])) stairRooms.add(r.id);
    }
    for (const r of s.level.rooms) if (/double.?height|\bvoid\b|atrium/i.test(r.name) && r.polygon.length >= 3) addVoid(s.above?.level.id, r.polygon);
  }
  const voidOver = (s: Storey, r: Room) => {
    const c = labelPoint(r.polygon);
    return (voids.get(s.above?.level.id ?? "") ?? []).some((v) => pointInPolygon(c, v));
  };

  const parkingTarget = (() => {
    const text = [...d.facts.map((f) => `${f.key} ${f.value}`), ...levels.flatMap((l) => [l.note ?? "", ...l.rooms.map((r) => r.name)])].join(" \n ");
    const m = text.match(/(\d{1,3})\s*(?:x|no\.?|nos\.?)?\s*car\s*(?:park|parking|spaces?|bays?)/i) ?? text.match(/(?:car\s*park(?:ing)?|parking)\s*(?:for|:)?\s*(\d{1,3})\s*cars?/i);
    return m ? Number(m[1]) : undefined;
  })();
  const parked = { n: 0 };

  for (const s of st) {
    const level = s.level;
    const E = level.elevationM;
    const roomById = new Map(level.rooms.map((r) => [r.id, r]));
    const wallExt = wallEndExtensions(level.walls);

    // ── rooms: floor finish, ceiling, light fittings; pools, sunken seating, ramps and parking ──
    level.rooms.forEach((r, ri) => {
      if (r.polygon.length < 3) {
        warnings.push(`Room "${r.name}" has fewer than 3 points and was skipped.`);
        return;
      }
      // sub-millimetre step per room: where traced outlines overlap, their faces are never coplanar
      const lift = (ri % 5) * 0.0006;
      const inferred = isInferred(r.evidence);
      const kind = roomKind(r);
      const outdoor = isOutdoor(r);
      const ramp = /\bramp\b/i.test(r.name);
      let floorMat: string;
      if (kind === "pool") { emitPool(e, s, r); floorMat = roleMat("water"); }
      else if (kind === "sunken") { emitSunken(e, s, r); floorMat = roleMat("paving"); }
      else if (ramp && s.above) { emitRamp(e, s, r); floorMat = roleMat("concrete"); }
      else {
        floorMat = outdoor ? (resolveMaterial(d, "floor", r)?.programs?.includes(r.program) ? useMat("floor", r, "auto:paving") : roleMat("paving")) : useMat("floor", r, kind === "garage" ? "auto:concrete" : "auto:floor");
        push({ elementId: r.id, elementKind: "floor", levelId: level.id, materialId: floorMat, inferred, shape: { type: "poly", polygon: r.polygon, y: round(E + PLATE_TOP + lift, 4), thickness: 0.03 } });
      }
      if (kind === "garage" && /car|park|garage|wash/i.test(r.name)) emitParking(e, s, r, parkingTarget, parked);

      const ceilingInferred = r.ceilingHeightM === undefined;
      const ceilingH = r.ceilingHeightM ?? level.heightM ?? DEFAULT_CEILING_M;
      const open = outdoor || ramp || stairRooms.has(r.id) || voidOver(s, r) || /\b(elev|lift|shaft|void|duct)\b/i.test(r.name);
      if (!open) {
        const cy = E + ceilingH - lift;
        push({ elementId: r.id, elementKind: "ceiling", levelId: level.id, materialId: useMat("ceiling", r, "auto:ceiling"), inferred: inferred || ceilingInferred, shape: { type: "poly", polygon: r.polygon, y: round(cy, 4), thickness: 0.05 } });
        if (LIT_KINDS.has(kind)) lights(r, kind, cy);
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
        ...(r.printedDims ? { printedDims: r.printedDims } : {}),
      });
      if (r.areaM2 !== undefined && Math.abs(r.areaM2 - computed) / Math.max(r.areaM2, 1) > 0.12) {
        warnings.push(`${r.name}: documented ${r.areaM2} m² vs traced polygon ${computed} m² (${Math.round(((computed - r.areaM2) / r.areaM2) * 100)}%).`);
      }
    });

    /** recessed downlights on a grid, and a cove of light around the ceiling edge of the main rooms */
    function lights(r: Room, kind: RoomKind, cy: number) {
      const light = auto("auto:light");
      const b = bboxOfPolys([r.polygon]);
      const W = b.maxX - b.minX, H = b.maxY - b.minY;
      const nx = Math.max(1, Math.round(W / 1.8)), ny = Math.max(1, Math.round(H / 1.8));
      let n = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const p = { x: b.minX + (W * (i + 0.5)) / nx, y: b.minY + (H * (j + 0.5)) / ny };
        const inset = [[0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]].every(([dx, dy]) => pointInPolygon({ x: p.x + dx, y: p.y + dy }, r.polygon));
        if (!inset || n >= 30) continue;
        n++;
        push({ elementId: `${r.id}-light`, elementKind: "light", levelId: level.id, materialId: light, inferred: true, shape: { type: "poly", polygon: circle(p.x, p.y, 0.05, 10), y: round(cy - 0.012, 4), thickness: 0.012 } });
      }
      if (COVE_KINDS.has(kind) && Math.abs(polygonArea(r.polygon)) >= 10) {
        const g = rasterize([r.polygon], 0.05, 0.5);
        const ring = subtract(offsetGrid(g, -0.3), offsetGrid(g, -0.36));
        for (const o of outlines(ring, 0.05)) {
          push({ elementId: `${r.id}-cove`, elementKind: "light", levelId: level.id, materialId: light, inferred: true, shape: { type: "poly", polygon: o.outer, holes: o.holes, y: round(cy - 0.008, 4), thickness: 0.006 } });
        }
      }
    }

    // ── walls & openings ──
    const ceilingOf = (r: Room | undefined) => r?.ceilingHeightM ?? level.heightM ?? DEFAULT_CEILING_M;
    for (const w of level.walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 0.05) continue;
      const wallInferred = isInferred(w.evidence);
      // each face of a solid wall takes the finish of the room it faces; a face onto the outside (no room, or
      // a terrace / garden / pool) takes the facade finish. Different finishes → two half-thickness leaves.
      const [leftRoom, rightRoom] = roomsBeside(w, level.rooms);
      const faceMat = (r: Room | undefined) => w.materialId ? byId(w.materialId, "auto:wall")
        : !r || OUTDOOR_RE.test(`${r.program} ${r.name}`) ? roleMat("facade")
        : useMat("wall", r, "auto:wall");
      const isGlass = w.kind === "glass";
      const isRail = w.kind === "railing";
      const T = w.thicknessM;
      // a low wall (parapet, planter, garden wall) keeps its drawn height; a full-height wall runs from the plate
      // to the underside of the plate above, so the facade has no gaps between storeys
      const low = isRail || w.heightM < 2;
      const H = low ? w.heightM : s.wallTop;
      const cH = Math.min(H, Math.max(ceilingOf(leftRoom), ceilingOf(rightRoom)));
      const leftMat = isGlass || isRail ? "" : faceMat(leftRoom);
      const rightMat = isGlass || isRail ? "" : faceMat(rightRoom);
      const glassMat = w.materialId && isGlass ? byId(w.materialId, "auto:glass") : roleMat("glass");
      const frameMat = roleMat("frame");
      const outsideMat = roleMat(leftRoom && rightRoom ? "facade" : "fascia");
      const b0 = low ? 0 : PLATE_TOP;
      /** a solid slice of the wall: one box, or two leaves when its faces have different finishes */
      const solid = (s0: number, e0: number, y0: number, y1: number, kind: ElementKind, elementId: string, inferred: boolean) => {
        if (y1 - y0 < 0.005) return;
        if (leftMat === rightMat) {
          push(box(w, s0, e0, y0, y1, T, { elementId, elementKind: kind, levelId: level.id, materialId: leftMat, inferred }, E));
          return;
        }
        push(box(w, s0, e0, y0, y1, T / 2, { elementId, elementKind: kind, levelId: level.id, materialId: leftMat, inferred }, E, T / 4));
        push(box(w, s0, e0, y0, y1, T / 2, { elementId, elementKind: kind, levelId: level.id, materialId: rightMat, inferred }, E, -T / 4));
      };
      const bar = (s0: number, e0: number, y0: number, y1: number, elementId: string, inferred: boolean, depth = Math.min(0.1, T)) =>
        push(box(w, s0, e0, y0, y1, depth, { elementId, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred }, E));
      const pane = (s0: number, e0: number, y0: number, y1: number, elementId: string, inferred: boolean, shift = 0) =>
        push(box(w, s0, e0, y0, y1, 0.024, { elementId, elementKind: "glass", levelId: level.id, materialId: glassMat, inferred }, E, shift));
      /** a framed glazed panel: glass with a frame all round, and mullions no more than `maxPane` apart */
      const glazed = (s0: number, e0: number, y0: number, y1: number, elementId: string, inferred: boolean, maxPane = 1.6, shift = 0) => {
        pane(s0 + FRAME_W / 2, e0 - FRAME_W / 2, y0 + FRAME_W / 2, y1 - FRAME_W / 2, elementId, inferred, shift);
        const depth = 0.07;
        push(box(w, s0, e0, y0, y0 + FRAME_W, depth, { elementId, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred }, E, shift));
        push(box(w, s0, e0, y1 - FRAME_W, y1, depth, { elementId, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred }, E, shift));
        const n = Math.max(1, Math.ceil((e0 - s0) / maxPane));
        for (let i = 0; i <= n; i++) {
          const m = s0 + ((e0 - s0) * i) / n;
          const a = Math.max(s0, m - FRAME_W / 2), z = Math.min(e0, m + FRAME_W / 2);
          push(box(w, a, z, y0 + FRAME_W, y1 - FRAME_W, depth, { elementId, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred }, E, shift));
        }
      };
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
      for (const { s: s0, e: e0 } of ops) {
        if (s0 > cursor + 1e-3) solids.push([cursor, s0]);
        cursor = Math.max(cursor, e0);
      }
      if (cursor < L - 1e-3) solids.push([cursor, L]);

      for (const [s0, e0] of solids) {
        const a = s0 === 0 ? -extA : s0;
        const z = e0 === L ? L + extB : e0;
        if (z - a < 0.01) continue;
        if (isRail) {
          push(box(w, a, z, 0, H - 0.05, 0.015, { elementId: w.id, elementKind: "railing", levelId: level.id, materialId: glassMat, inferred: wallInferred }, E));
          push(box(w, a, z, H - 0.05, H, 0.05, { elementId: w.id, elementKind: "handrail", levelId: level.id, materialId: frameMat, inferred: wallInferred }, E));
          push(box(w, a, z, 0, 0.06, 0.06, { elementId: w.id, elementKind: "frame", levelId: level.id, materialId: frameMat, inferred: wallInferred }, E));
        } else if (isGlass) {
          glazed(a, z, 0, cH, w.id, wallInferred);
        } else {
          solid(a, z, b0, H, "wall", w.id, wallInferred);
        }
      }
      // above a glazed wall's ceiling line: a solid band up to the plate above (the facade reads as floor bands)
      if (isGlass && H > cH + 0.02) push(box(w, 0, L, cH, H, Math.max(T, 0.2), { elementId: w.id, elementKind: "lintel", levelId: level.id, materialId: outsideMat, inferred: true }, E));

      for (const { o, s: s0, e: e0 } of ops) {
        const inf = isInferred(o.evidence);
        const base = { elementId: o.id, levelId: level.id, inferred: inf };
        const sill = o.kind === "window" ? (o.sillM ?? DEFAULT_WINDOW_SILL_M) : (o.sillM ?? 0);
        if (o.kind === "window" && o.sillM === undefined) warnings.push(`Window ${o.id}: no sill height documented, using ${DEFAULT_WINDOW_SILL_M} m.`);
        const top = isGlass ? cH : Math.min(cH, H);
        const head = Math.min(top, sill + o.heightM);
        if (isRail) continue;
        if (isGlass) {
          // in a glazed wall the sill and the transom above a door are glass in a slim frame, not solid panels
          if (sill > 0.01) glazed(s0, e0, 0, sill, o.id, inf);
          if (head < top - 0.02) glazed(s0, e0, head, top, o.id, inf);
        } else {
          if (sill > 0.01) solid(s0, e0, b0, sill, "sill", o.id, inf);
          if (head < H - 0.01) solid(s0, e0, head, H, "lintel", o.id, inf);
        }
        if (o.kind === "window") {
          glazed(s0, e0, sill, head, o.id, inf, 1.2);
        } else if (o.kind === "sliding_door") {
          // two framed panels in the wall's depth: a fixed one, and the sliding one parked in front of it (half open)
          const mid = (s0 + e0) / 2;
          const d0 = Math.min(0.045, T / 4);
          glazed(s0, mid + 0.03, 0, head, o.id, inf, 3, -d0);
          glazed(s0 + 0.04, mid + 0.07, 0, head, o.id, inf, 3, d0);
          bar(s0, e0, head - FRAME_W, head, o.id, inf, Math.min(0.16, T));
          bar(s0, e0, 0, 0.02, o.id, inf, Math.min(0.16, T));
        } else if (o.kind === "door") {
          const jamb = Math.min(0.04, (e0 - s0) / 8);
          const joinery = useMat("joinery", undefined, "auto:door");
          for (const [a, z] of [[s0, s0 + jamb], [e0 - jamb, e0]]) push(box(w, a, z, 0, head, T + 0.02, { ...base, elementKind: "frame", materialId: joinery }, E));
          push(box(w, s0, e0, head - jamb, head, T + 0.02, { ...base, elementKind: "frame", materialId: joinery }, E));
          push(doorLeaf(w, s0 + jamb, e0 - jamb, 0, head - jamb, { ...base, elementKind: "door_leaf", materialId: joinery }, E, level.rooms));
        }
      }

      // walk-mode colliders: everything except passable openings
      const blocks: Array<[number, number]> = [];
      cursor = 0;
      for (const { o, s: s0, e: e0 } of ops) {
        if (!PASSABLE.has(o.kind)) continue;
        const [ps, pe] = o.kind === "sliding_door" ? [(s0 + e0) / 2, e0] : [s0, e0];
        if (ps > cursor) blocks.push([cursor, ps]);
        cursor = Math.max(cursor, pe);
      }
      if (cursor < L) blocks.push([cursor, L]);
      for (const [a, z] of blocks) {
        colliders.push({ levelId: level.id, a: along(w, a), b: along(w, z), halfThickness: Math.max(T / 2, 0.05) });
      }
    }

    // ── stairs up from this storey ──
    for (const plan of stairs.get(level.id) ?? []) if (s.above) emitStair(e, level.id, E, s.above.E - E, plan);

    // ── furniture: what the plan draws, then illustrative pieces that dress each room ──
    const drawn: Array<FurnitureLike & { inferred: boolean; roomId?: string }> = (level.furniture ?? []).map((f) => ({ ...f, inferred: isInferred(f.evidence) }));
    const staged = stageLevel(level, { top: s.top }).map((f) => ({ ...f, sizeM: { ...f.sizeM, h: f.sizeM.h || furnitureHeight(f.kind) }, inferred: true }));
    for (const f of [...drawn, ...staged]) {
      const room = f.roomId ? roomById.get(f.roomId) : level.rooms.find((r) => r.polygon.length >= 3 && pointInPolygon(f.center, r.polygon));
      const kind: ElementKind = LIGHT_KINDS.has(f.kind) ? "light" : f.kind === "curtain" ? "curtain" : f.kind === "car" ? "vehicle" : "furniture";
      const ceilingH = ceilingOf(room);
      for (const part of furnitureParts(f, ceilingH)) {
        if (part.w <= 0.005 || part.d <= 0.005 || part.y1 - part.y0 <= 0.003) continue;
        const materialId = partMat(part.mat, room);
        const a = (f.rotationDeg * Math.PI) / 180;
        const ctr = rot3(f, part.dx, part.dy, E + part.y0 + (part.y1 - part.y0) / 2);
        if (part.round) {
          push({ elementId: f.id, elementKind: kind, levelId: level.id, materialId, inferred: f.inferred, shape: { type: "poly", polygon: circle(ctr.x, -ctr.z, part.w / 2, part.w > 0.6 ? 28 : 14), y: round(E + part.y0, 4), thickness: round(part.y1 - part.y0, 4) } });
          continue;
        }
        push({
          elementId: f.id, elementKind: kind, levelId: level.id, materialId, inferred: f.inferred,
          shape: {
            type: "box",
            center: ctr,
            size: { x: round(part.w), y: round(part.y1 - part.y0), z: round(part.d) },
            rotY: round(a + (part.rot ?? 0), 5),
            ...(part.bevel ? { bevel: part.bevel } : {}),
            ...(part.pitch ? { pitch: round(part.pitch, 5) } : {}),
          },
        });
      }
    }
  }

  function partMat(m: PartMat, room: Room | undefined): string {
    switch (m) {
      case "joinery": return useMat("joinery", room, "auto:joinery");
      case "counter": return useMat("counter", room, "auto:stone");
      case "paint": return auto("auto:carpaint1");
      case "water": return roleMat("water");
      default: return auto(`auto:${m}`);
    }
  }

  // floor plates, slab edges and roofs; then the plot around the house
  const ext = d.exterior;
  emitPlates(e, st, { overhang: ext?.overhangM ?? (ext?.slabEdges === "none" ? 0 : 0.35), fascia: ext?.slabEdges !== "none", voids });
  emitSite(e, st, d);

  // wall tops are drawn as a dark cut line in cut-away views (scene/geometry.ts)
  if (pieces.some((p) => p.elementKind === "wall")) mats.set("auto:cap", FALLBACKS["auto:cap"]);

  // bounds of the building (the planting around the plot is left out so views frame the house)
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pieces) {
    if (p.elementKind === "site" || p.elementKind === "planting") continue;
    if (p.shape.type === "box") {
      const { center: c, size: sz, rotY } = p.shape;
      const cos = Math.cos(rotY), sin = Math.sin(rotY);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = (lx * sz.x) / 2, z = (lz * sz.z) / 2;
        extend(min, max, c.x + x * cos + z * sin, c.y - sz.y / 2, c.z - x * sin + z * cos);
        extend(min, max, c.x + x * cos + z * sin, c.y + sz.y / 2, c.z - x * sin + z * cos);
      }
    } else {
      for (const v of p.shape.polygon) extend(min, max, v.x, p.shape.y, -v.y), extend(min, max, v.x, p.shape.y + p.shape.thickness, -v.y);
    }
  }
  if (!isFinite(min.x)) { min.x = min.y = min.z = 0; max.x = max.y = max.z = 1; }

  // spawn in the entrance if there is one, else the largest living space
  // start on the level at street level (elevation closest to 0), not in a basement lobby
  const streetLevel = st.find((s) => s.street)?.level.id;
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
function extend(min: Vec3, max: Vec3, x: number, y: number, z: number) {
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

function rot3(f: Pick<FurnitureLike, "center" | "rotationDeg">, dx: number, dy: number, y: number): Vec3 {
  const a = (f.rotationDeg * Math.PI) / 180;
  const x = f.center.x + dx * Math.cos(a) - dy * Math.sin(a);
  const py = f.center.y + dx * Math.sin(a) + dy * Math.cos(a);
  return { x: round(x), y: round(y), z: round(-py) };
}
