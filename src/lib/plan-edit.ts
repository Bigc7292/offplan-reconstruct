// Pure dossier-editing operations used by the 2D plan editor. Each returns a new Level.
// Edits add "user" evidence so the review trail shows who changed what.
import type { Evidence, Level, Opening, Room, Vec2, Wall } from "./schema";
import { inferredEvidence } from "./schema";
import { dist, round } from "./geom";

const SNAP = 0.02; // metres: endpoints closer than this are "the same joint"

export function userEvidence(what: string, planPage?: number): Evidence {
  return { source: "user", ref: planPage ? `page-${planPage}` : "review", quote: `Reviewer: ${what}`, confidence: 0.75 };
}

export function planPageOf(level: Level): number | undefined {
  const m = level.plan?.assetId.match(/^a(\d+)-|^page-(\d+)$/);
  return m ? Number(m[1] ?? m[2]) : Number(level.id.match(/^L-p(\d+)/)?.[1]) || undefined;
}

const same = (a: Vec2, b: Vec2) => dist(a, b) < SNAP;
const r2 = (p: Vec2): Vec2 => ({ x: round(p.x), y: round(p.y) });

/** Move a joint: every wall endpoint and room vertex at `from` moves to `to`. */
export function moveJoint(level: Level, from: Vec2, to: Vec2, why: string): Level {
  const t = r2(to);
  const ev = userEvidence(why, planPageOf(level));
  return {
    ...level,
    walls: level.walls.map((w) => {
      const ma = same(w.a, from), mb = same(w.b, from);
      if (!ma && !mb) return w;
      return rescaleOpenings(w, { ...w, a: ma ? t : w.a, b: mb ? t : w.b, evidence: [...w.evidence, ev] });
    }),
    rooms: level.rooms.map((r) => {
      if (!r.polygon.some((p) => same(p, from))) return r;
      return { ...r, polygon: r.polygon.map((p) => (same(p, from) ? t : p)), evidence: [...r.evidence, ev] };
    }),
  };
}

/** Keep openings at the same absolute distance from `a` when a wall changes length. */
function rescaleOpenings(before: Wall, after: Wall): Wall {
  const L0 = dist(before.a, before.b), L1 = dist(after.a, after.b);
  if (L1 < 1e-6 || Math.abs(L0 - L1) < 1e-6) return after;
  const aMoved = !same(before.a, after.a);
  return {
    ...after,
    openings: after.openings.map((o) => {
      const fromA = aMoved ? L1 - (1 - o.offset) * L0 : o.offset * L0;
      return { ...o, offset: Math.min(1, Math.max(0, round(fromA / L1, 4))) };
    }),
  };
}

/** Set a wall's length by moving endpoint b along the wall direction (joined walls/rooms follow). */
export function setWallLength(level: Level, wallId: string, lengthM: number): Level {
  const w = level.walls.find((x) => x.id === wallId);
  if (!w || lengthM <= 0.05) return level;
  const L = dist(w.a, w.b);
  const to = { x: w.a.x + ((w.b.x - w.a.x) / L) * lengthM, y: w.a.y + ((w.b.y - w.a.y) / L) * lengthM };
  return moveJoint(level, w.b, to, `set ${wallId} length to ${lengthM.toFixed(2)} m`);
}

export function updateWall(level: Level, wallId: string, patch: Partial<Wall>, why: string): Level {
  return { ...level, walls: level.walls.map((w) => (w.id === wallId ? { ...w, ...patch, evidence: [...w.evidence, userEvidence(why, planPageOf(level))] } : w)) };
}

export function updateRoom(level: Level, roomId: string, patch: Partial<Room>, why: string): Level {
  return { ...level, rooms: level.rooms.map((r) => (r.id === roomId ? { ...r, ...patch, evidence: [...r.evidence, userEvidence(why, planPageOf(level))] } : r)) };
}

export function updateOpening(level: Level, openingId: string, patch: Partial<Opening>, why: string): Level {
  return {
    ...level,
    walls: level.walls.map((w) => ({
      ...w,
      openings: w.openings.map((o) => (o.id === openingId ? { ...o, ...patch, evidence: [...o.evidence, userEvidence(why, planPageOf(level))] } : o)),
    })),
  };
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`;

export function addWall(level: Level, a: Vec2, b: Vec2, kind: Wall["kind"] = "interior"): Level {
  const w: Wall = {
    id: uid(`${level.id}-w`), a: r2(a), b: r2(b), kind,
    thicknessM: kind === "exterior" ? 0.2 : kind === "railing" ? 0.06 : 0.12,
    heightM: kind === "railing" ? 1.1 : level.heightM,
    openings: [], evidence: [userEvidence(`traced ${kind} wall`, planPageOf(level))],
  };
  return { ...level, walls: [...level.walls, w] };
}

export function addOpening(level: Level, wallId: string, at: Vec2, kind: Opening["kind"]): Level {
  const w = level.walls.find((x) => x.id === wallId);
  if (!w) return level;
  const L = dist(w.a, w.b);
  const t = ((at.x - w.a.x) * (w.b.x - w.a.x) + (at.y - w.a.y) * (w.b.y - w.a.y)) / (L * L);
  const widthM = kind === "window" ? 1.2 : kind === "sliding_door" ? 2.4 : 0.9;
  const o: Opening = {
    id: uid(`${w.id}-o`), kind, wallId, offset: Math.min(1, Math.max(0, round(t, 4))), widthM,
    heightM: kind === "window" ? 1.5 : kind === "sliding_door" ? 2.4 : 2.2,
    sillM: kind === "window" ? 0.9 : 0,
    evidence: [userEvidence(`placed ${kind.replace("_", " ")}`, planPageOf(level))],
  };
  return { ...level, walls: level.walls.map((x) => (x.id === wallId ? { ...x, openings: [...x.openings, o] } : x)) };
}

export function removeElement(level: Level, id: string): Level {
  return {
    ...level,
    walls: level.walls.filter((w) => w.id !== id).map((w) => ({ ...w, openings: w.openings.filter((o) => o.id !== id) })),
    rooms: level.rooms.filter((r) => r.id !== id),
    furniture: level.furniture?.filter((f) => f.id !== id),
  };
}

/** Place (or re-place) a room as an axis-aligned rectangle traced over the plan. */
export function traceRoomRect(level: Level, roomId: string | null, a: Vec2, b: Vec2, name = "Room"): { level: Level; roomId: string } {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)].map((v) => round(v));
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)].map((v) => round(v));
  const polygon = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const ev = userEvidence(`traced outline ${(x1 - x0).toFixed(2)} × ${(y1 - y0).toFixed(2)} m`, planPageOf(level));
  if (roomId && level.rooms.some((r) => r.id === roomId)) {
    return { level: { ...level, rooms: level.rooms.map((r) => (r.id === roomId ? { ...r, polygon, evidence: [...r.evidence, ev] } : r)) }, roomId };
  }
  const id = uid(`${level.id}-r`);
  const room: Room = { id, name, program: "other", polygon, levelId: level.id, adjacentRoomIds: [], ceilingHeightM: undefined, evidence: [ev] };
  return { level: { ...level, rooms: [...level.rooms, room] }, roomId: id };
}

/**
 * Walls from traced room outlines: shared edges become interior walls, unshared edges exterior
 * (or railings where the room is a balcony/terrace). No openings are invented.
 */
export function wallsFromRooms(level: Level): Level {
  type Seg = { a: Vec2; b: Vec2; rooms: Room[] };
  const segs: Seg[] = [];
  const placed = level.rooms.filter((r) => r.polygon.length >= 3);
  // split every edge at every vertex that lies on it, so partial overlaps become exact shared segments
  const verts = placed.flatMap((r) => r.polygon);
  for (const r of placed) {
    for (let i = 0; i < r.polygon.length; i++) {
      const a = r.polygon[i], b = r.polygon[(i + 1) % r.polygon.length];
      const L = dist(a, b);
      if (L < 0.05) continue;
      const ts = [0, 1, ...verts.map((v) => {
        const t = ((v.x - a.x) * (b.x - a.x) + (v.y - a.y) * (b.y - a.y)) / (L * L);
        const px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
        return t > 0.001 && t < 0.999 && Math.hypot(px - v.x, py - v.y) < SNAP ? t : null;
      }).filter((t): t is number => t !== null)].sort((p, q) => p - q);
      for (let k = 0; k < ts.length - 1; k++) {
        if (ts[k + 1] - ts[k] < 1e-4) continue;
        const pa = r2({ x: a.x + ts[k] * (b.x - a.x), y: a.y + ts[k] * (b.y - a.y) });
        const pb = r2({ x: a.x + ts[k + 1] * (b.x - a.x), y: a.y + ts[k + 1] * (b.y - a.y) });
        const hit = segs.find((s) => (same(s.a, pa) && same(s.b, pb)) || (same(s.a, pb) && same(s.b, pa)));
        if (hit) hit.rooms.push(r);
        else segs.push({ a: pa, b: pb, rooms: [r] });
      }
    }
  }
  const outdoor = (r: Room) => /balcony|terrace|garden|pool|deck|outdoor/i.test(`${r.program} ${r.name}`);
  const page = planPageOf(level);
  const walls: Wall[] = segs.map((s, i) => {
    const shared = s.rooms.length > 1;
    const allOutdoor = s.rooms.every(outdoor);
    const kind: Wall["kind"] = shared ? (s.rooms.some(outdoor) && s.rooms.some((r) => !outdoor(r)) ? "glass" : allOutdoor ? "railing" : "interior") : allOutdoor ? "railing" : "exterior";
    return {
      id: `${level.id}-w${i + 1}`,
      a: s.a, b: s.b, kind,
      thicknessM: kind === "exterior" ? 0.2 : kind === "railing" ? 0.06 : kind === "glass" ? 0.15 : 0.12,
      heightM: kind === "railing" ? 1.1 : level.heightM,
      openings: [],
      evidence: [{ source: "user", ref: page ? `page-${page}` : "review", quote: `Derived from traced outline of ${s.rooms.map((r) => r.name).join(" / ")}`, confidence: 0.6 }],
    };
  });
  return { ...level, walls };
}

/** Explicit, flagged helper: a 0.9 m opening on every interior wall between two rooms that have none. */
export function addInferredDoors(level: Level): Level {
  return {
    ...level,
    walls: level.walls.map((w) => {
      if (w.kind !== "interior" && w.kind !== "partition" && w.kind !== "glass") return w;
      if (w.openings.length || dist(w.a, w.b) < 1.1) return w;
      const kind: Opening["kind"] = w.kind === "glass" ? "sliding_door" : "door";
      return {
        ...w,
        openings: [{
          id: `${w.id}-o-inf`, kind, wallId: w.id, offset: 0.5, widthM: kind === "sliding_door" ? Math.min(2.4, dist(w.a, w.b) * 0.6) : 0.9, heightM: 2.2, sillM: 0,
          evidence: [inferredEvidence("door position not shown on plan; placed at wall centre", 0.15)],
        }],
      };
    }),
  };
}

/** Calibrate scale from two points and their true distance. Traced geometry is rescaled with the underlay. */
export function calibrate(level: Level, p: Vec2, q: Vec2, trueM: number, quote: string): Level {
  const cur = dist(p, q);
  if (cur < 1e-6 || trueM <= 0 || !level.plan) return level;
  const k = trueM / cur;
  const sc = (v: Vec2): Vec2 => r2({ x: v.x * k, y: v.y * k });
  const page = planPageOf(level);
  return {
    ...level,
    plan: {
      ...level.plan,
      pxPerM: round(level.plan.pxPerM / k, 4),
      scaleConfidence: 0.8,
      evidence: [{ source: "user", ref: page ? `page-${page}` : "review", quote: `Scale calibrated by reviewer: ${quote} = ${trueM.toFixed(2)} m`, confidence: 0.8 }],
    },
    walls: level.walls.map((w) => ({ ...w, a: sc(w.a), b: sc(w.b), openings: w.openings })),
    rooms: level.rooms.map((r) => ({ ...r, polygon: r.polygon.map(sc) })),
    furniture: level.furniture?.map((f) => ({ ...f, center: sc(f.center), sizeM: { ...f.sizeM, w: f.sizeM.w * k, d: f.sizeM.d * k } })),
  };
}
