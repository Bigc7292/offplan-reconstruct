// Guided walkthrough of a reconstructed property: an opening exterior orbit, then each floor as a
// cut-away followed by its main rooms at eye height, then a closing aerial. Pure function of the
// scene graph, so any property gets the same kind of tour and the video is reproducible frame by frame.
//
// World space is three.js: x = plan x, y = elevation, z = -plan y.
import type { PropertySceneGraph, SceneRoom, Vec2, Vec3 } from "./schema";
import { roomViewpoint, pointInPolygon } from "./geom";

export type CamKey = { pos: Vec3; target: Vec3 };
export type TourShot = {
  kind: "exterior" | "floor" | "room";
  title: string;
  subtitle?: string;
  /** levels drawn during the shot */
  levels: string[];
  ceilings: boolean;
  duration: number; // seconds
  fov: number;
  /** camera keyframes, eased from the first to the last */
  path: CamKey[];
  roomId?: string;
  levelId?: string;
  /** an outdoor space (terrace, pool, garden): captioned "Outside" and lit by daylight only */
  outdoor?: boolean;
  /** draw this storey as a section with its walls cut at this height (cut-away floor shots) */
  cut?: { levelId: string; y: number };
};

const OUTDOOR_RE = /terrace|garden|pool|deck|court|lawn|balcony|patio|sunken|bbq/i;
export const isOutdoorRoom = (r: Pick<SceneRoom, "program" | "name">) => r.program === "balcony" || OUTDOOR_RE.test(r.name);

export const FADE_S = 0.4;

const EXCLUDE = /circulation|corridor|lobby|stair|lift|shaft|store|storage|pump|plant|laundry|service|duct|void|wc\b|powder|toilet|closet|walk.?in|dressing|maid|driver|garbage|electrical|mep/i;

function bbox(pts: Vec2[]) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Rooms worth a shot on one level, in walking order. */
export function tourRooms(scene: PropertySceneGraph, levelId: string, max = 5): SceneRoom[] {
  const rooms = scene.rooms.filter((r) => r.levelId === levelId && r.polygon.length >= 3 && !r.inferred);
  const score = (r: SceneRoom) => {
    const b = bbox(r.polygon);
    const minDim = Math.min(b.maxX - b.minX, b.maxY - b.minY);
    if (minDim < 2.2 || r.computedAreaM2 < 7) return -1;
    if (EXCLUDE.test(r.name) || r.program === "circulation" || r.program === "storage") return -1;
    const outdoor = r.program === "balcony" || /terrace|garden|pool|deck|court/i.test(r.name);
    if (outdoor) return r.computedAreaM2 >= 15 ? 40 + Math.min(r.computedAreaM2, 80) / 10 : -1;
    if (r.program === "bath" && r.computedAreaM2 < 12) return -1;
    const base: Record<string, number> = { living: 100, kitchen: 90, bedroom: 80, amenity: 70, other: 50, bath: 45 };
    const master = /master|main|principal/i.test(r.name) ? 8 : 0;
    return (base[r.program] ?? 40) + master + Math.min(r.computedAreaM2, 60) / 6;
  };
  const picked: SceneRoom[] = [];
  let baths = 0, outdoors = 0;
  for (const r of [...rooms].sort((a, b) => score(b) - score(a))) {
    const s = score(r);
    if (s < 0 || picked.length >= max) continue;
    const outdoor = r.program === "balcony" || /terrace|garden|pool|deck|court/i.test(r.name);
    if (r.program === "bath" && baths++ >= 1) continue;
    if (outdoor && outdoors++ >= 1) continue;
    picked.push(r);
  }
  if (picked.length < 2) return picked;
  // walk order: start from the most important room, then always the nearest unvisited one
  const order = [picked[0]];
  const left = picked.slice(1);
  while (left.length) {
    const last = order[order.length - 1].centroid;
    left.sort((a, b) => Math.hypot(a.centroid.x - last.x, a.centroid.z - last.z) - Math.hypot(b.centroid.x - last.x, b.centroid.z - last.z));
    order.push(left.shift()!);
  }
  return order;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/**
 * Eye-level camera for a room: stand where the room's furniture (the bed, the sofa group, the table) is seen
 * whole, i.e. the free spot farthest from it, and look at it. Rooms without furniture fall back to looking
 * down their length.
 */
export function roomCamera(scene: PropertySceneGraph, r: SceneRoom): { x: number; y: number; lookX: number; lookY: number; lookH: number } {
  const inRoom = (p: Vec2) => pointInPolygon(p, r.polygon);
  const b = bbox(r.polygon);
  const E = r.centroid.y;
  /** clear of the walls by `m` metres in the four plan directions and the diagonals */
  const roomy = (p: Vec2, m: number) => [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m], [m * 0.7, m * 0.7], [-m * 0.7, m * 0.7], [m * 0.7, -m * 0.7], [-m * 0.7, -m * 0.7]].every(([dx, dy]) => inRoom({ x: p.x + dx, y: p.y + dy }));
  const grid = (inset: number, n = 7) => {
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      out.push({ x: b.minX + inset + ((b.maxX - b.minX - 2 * inset) * i) / (n - 1), y: b.minY + inset + ((b.maxY - b.minY - 2 * inset) * j) / (n - 1) });
    }
    return out;
  };
  /** how far one can see from p in direction u before leaving the room */
  const reach = (p: Vec2, u: Vec2) => {
    let t = 0;
    while (t < 30 && inRoom({ x: p.x + u.x * (t + 0.1), y: p.y + u.y * (t + 0.1) })) t += 0.1;
    return t;
  };
  // the view line must stay inside the room (no looking through a wall at furniture next door)
  const seen = (a: Vec2, t: Vec2) => {
    for (let k = 1; k <= 12; k++) if (!inRoom({ x: a.x + ((t.x - a.x) * k) / 13, y: a.y + ((t.y - a.y) * k) / 13 })) return false;
    return true;
  };
  // outdoor spaces (pool, terrace, garden): stand by the house and look out across the space to the view
  if (isOutdoorRoom(r)) {
    const indoor = scene.rooms.filter((x) => x.levelId === r.levelId && !isOutdoorRoom(x));
    if (indoor.length) {
      const hx = indoor.reduce((a, x) => a + x.centroid.x, 0) / indoor.length;
      const hy = -indoor.reduce((a, x) => a + x.centroid.z, 0) / indoor.length;
      for (const m of [0.8, 0.5, 0.3]) {
        const pts = grid(m).filter((p) => roomy(p, m));
        if (pts.length < 2) continue;
        const byHouse = [...pts].sort((a, c) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(c.x - hx, c.y - hy));
        // near the house, looking out: score each pair by length and by how squarely it points away from the house
        let pick: { near: Vec2; far: Vec2; s: number } | null = null;
        for (const near of byHouse.slice(0, 6)) {
          const ax = near.x - hx, ay = near.y - hy, al = Math.hypot(ax, ay) || 1;
          for (const far of pts) {
            const L = Math.hypot(far.x - near.x, far.y - near.y);
            if (L < 2.5 || !seen(near, far)) continue;
            const away = ((far.x - near.x) * ax + (far.y - near.y) * ay) / (L * al);
            if (away < 0.35) continue;
            const sc = Math.min(L, 10) + away * 4;
            if (!pick || sc > pick.s) pick = { near, far, s: sc };
          }
        }
        if (pick) return { x: pick.near.x, y: pick.near.y, lookX: pick.far.x, lookY: pick.far.y, lookH: 1.2 };
      }
    }
  }
  /** a target height that keeps the view within ~12 degrees of level from eye height (1.6 m) */
  const gentle = (dist: number) => Math.max(0.7, Math.min(1.35, 1.6 - dist * 0.21));
  const furniture = scene.pieces
    // pendants hanging into head height count as obstacles too (a lamp shade filling the frame)
    .filter((p) => p.levelId === r.levelId && (p.elementKind === "furniture" || (p.elementKind === "light" && (p.shape.type === "box" ? p.shape.center.y - p.shape.size.y / 2 : p.shape.y) < E + 2.4)))
    .map((p) => {
      if (p.shape.type === "box") {
        const sh = p.shape;
        const ext = Math.max(sh.size.x, sh.size.z);
        return { x: sh.center.x, y: -sh.center.z, w: ext, d: ext, area: sh.size.x * sh.size.z, top: sh.center.y + sh.size.y / 2 - E };
      }
      const pb = bbox(p.shape.polygon);
      return { x: (pb.minX + pb.maxX) / 2, y: (pb.minY + pb.maxY) / 2, w: pb.maxX - pb.minX, d: pb.maxY - pb.minY, area: (pb.maxX - pb.minX) * (pb.maxY - pb.minY), top: p.shape.y + p.shape.thickness - E };
    })
    .filter((f) => inRoom(f) && f.area > 0.04);
  const obstacles = furniture.filter((f) => f.top > 0.1);
  const seating = furniture.filter((f) => f.top < 2.2);
  if (seating.length) {
    let wx = 0, wy = 0, wt = 0;
    for (const f of seating) { wx += f.x * f.area; wy += f.y * f.area; wt += f.area; }
    const focus = { x: wx / wt, y: wy / wt };
    // stand in a corner or by the door side, clear of walls and furniture, far enough back to see the room whole,
    // and never facing a wall at close range (a frame filled by one surface)
    for (const [wall, obst] of [[0.8, 0.8], [0.6, 0.6], [0.45, 0.35]]) {
      const clear = (p: Vec2) => roomy(p, wall) && obstacles.every((f) => Math.abs(p.x - f.x) > f.w / 2 + obst || Math.abs(p.y - f.y) > f.d / 2 + obst);
      const best = grid(wall)
        .filter(clear)
        .filter((p) => seen(p, focus))
        .map((p) => {
          const dist = Math.hypot(p.x - focus.x, p.y - focus.y);
          const u = { x: (focus.x - p.x) / (dist || 1), y: (focus.y - p.y) / (dist || 1) };
          return { p, dist, depth: reach(p, u) };
        })
        .filter((c) => c.dist > 1.8 && c.depth > 2.4)
        .sort((a, c) => Math.min(c.dist, 7.5) + Math.min(c.depth, 9) * 0.3 - (Math.min(a.dist, 7.5) + Math.min(a.depth, 9) * 0.3))[0];
      if (best) return { x: best.p.x, y: best.p.y, lookX: focus.x, lookY: focus.y, lookH: gentle(best.dist) };
    }
    // tight rooms: the spot with the most room around it that still sees the furniture, looking at it
    const gap = (p: Vec2) => Math.min(1.2, ...obstacles.map((f) => Math.max(Math.abs(p.x - f.x) - f.w / 2, Math.abs(p.y - f.y) - f.d / 2)));
    const fallback = grid(0.3, 9)
      .filter((p) => roomy(p, 0.3) && seen(p, focus) && Math.hypot(p.x - focus.x, p.y - focus.y) > 1.2)
      .map((p) => ({ p, score: gap(p) * 2 + Math.min(Math.hypot(p.x - focus.x, p.y - focus.y), 6) * 1.2 }))
      .sort((a, c) => c.score - a.score)[0];
    if (fallback) {
      // look past the furniture to the far side of the room, not down onto it
      const d0 = Math.hypot(fallback.p.x - focus.x, fallback.p.y - focus.y) || 1;
      const u = { x: (focus.x - fallback.p.x) / d0, y: (focus.y - fallback.p.y) / d0 };
      const far = Math.max(d0, reach(fallback.p, u) - 0.3);
      return { x: fallback.p.x, y: fallback.p.y, lookX: fallback.p.x + u.x * far, lookY: fallback.p.y + u.y * far, lookH: gentle(far) };
    }
  }
  const vp = roomViewpoint(r.polygon);
  const yaw = (vp.yawDeg * Math.PI) / 180;
  return { x: vp.x, y: vp.y, lookX: vp.x - Math.sin(yaw) * 4, lookY: vp.y + Math.cos(yaw) * 4, lookH: 1.2 };
}

export function buildTour(scene: PropertySceneGraph): TourShot[] {
  const levels = [...scene.levels].sort((a, b) => a.elevationM - b.elevationM);
  const above = levels.filter((l) => l.elevationM >= -0.01);
  const shown = above.length ? above : levels;
  const street = [...levels].sort((a, b) => Math.abs(a.elevationM) - Math.abs(b.elevationM))[0];
  const pts = scene.rooms.filter((r) => shown.some((l) => l.id === r.levelId)).flatMap((r) => r.polygon);
  const bb = pts.length ? bbox(pts) : { minX: scene.bounds.min.x, maxX: scene.bounds.max.x, minY: -scene.bounds.max.z, maxY: -scene.bounds.min.z };
  const cx = (bb.minX + bb.maxX) / 2, cz = -(bb.minY + bb.maxY) / 2;
  const size = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 8);
  const top = Math.max(...shown.map((l) => l.elevationM + l.heightM));
  const base = street?.elevationM ?? 0;

  // look at the house from its main outdoor space (garden / pool side) when there is one
  const outdoor = scene.rooms
    .filter((r) => r.levelId === street?.id && (r.program === "balcony" || /pool|garden|terrace|deck|lawn/i.test(r.name)))
    .sort((a, b) => b.computedAreaM2 - a.computedAreaM2)[0];
  const a0 = outdoor ? Math.atan2(outdoor.centroid.z - cz, outdoor.centroid.x - cx) - Math.PI / 5 : (-3 * Math.PI) / 4;

  const orbit = (ang: number, r: number, h: number, ty: number): CamKey => ({
    pos: v3(cx + Math.cos(ang) * r, h, cz + Math.sin(ang) * r),
    target: v3(cx, ty, cz),
  });
  const all = levels.map((l) => l.id);
  const shots: TourShot[] = [];

  const R = size * 1.2;
  shots.push({
    kind: "exterior", title: scene.title, subtitle: "A walkthrough built from the sales brochure",
    levels: shown.map((l) => l.id), ceilings: true, duration: 7, fov: 40,
    path: [0, 0.5, 1].map((k) => orbit(a0 - 0.5 + k * 0.9, R * (1.08 - 0.12 * k), base + size * (0.55 - 0.15 * k), base + (top - base) * 0.35)),
  });

  // any basement first, as a cut-away only (no eye-level shots below ground), then street level and up,
  // ending on the top floor's outdoor space
  const streetE = street?.elevationM ?? 0;
  const order = [...levels.filter((l) => l.elevationM < streetE - 1e-6), ...levels.filter((l) => l.elevationM >= streetE - 1e-6)];
  for (const lvl of order) {
    const rooms = scene.rooms.filter((r) => r.levelId === lvl.id && r.polygon.length >= 3);
    if (!rooms.length) continue;
    const below = lvl.elevationM < streetE - 1e-6;
    const lb = bbox(rooms.flatMap((r) => r.polygon));
    const lx = (lb.minX + lb.maxX) / 2, lz = -(lb.minY + lb.maxY) / 2;
    const ls = Math.max(lb.maxX - lb.minX, lb.maxY - lb.minY, 6);
    const stack = levels.filter((l) => l.elevationM <= lvl.elevationM + 1e-6).map((l) => l.id);
    const named = rooms.filter((r) => !/unlabelled/i.test(r.name));
    const internal = named.filter((r) => !isOutdoorRoom(r)).reduce((s, r) => s + r.areaM2, 0);
    // frame the whole floor: back off until its diagonal fits the 40° lens with a margin
    const fit = (Math.hypot(lb.maxX - lb.minX, lb.maxY - lb.minY) / 2) / Math.tan((20 * Math.PI) / 180) * 0.92;
    shots.push({
      kind: "floor", title: lvl.name, subtitle: `${named.length} spaces${internal > 0 ? ` · about ${Math.round(internal)} m² of rooms` : ""}`,
      levels: stack, ceilings: false, duration: 5, fov: 40, levelId: lvl.id, cut: { levelId: lvl.id, y: lvl.elevationM + 1.2 },
      path: [0, 1].map((k) => {
        const ang = a0 + 0.15 + k * 0.4;
        const dist = Math.max(ls * 0.9, fit) * (1 - 0.06 * k);
        const pitch = 0.95 - 0.08 * k; // radians below the horizon
        return { pos: v3(lx + Math.cos(ang) * dist * Math.cos(pitch), lvl.elevationM + dist * Math.sin(pitch), lz + Math.sin(ang) * dist * Math.cos(pitch)), target: v3(lx, lvl.elevationM, lz) };
      }),
    });
    if (below) continue;
    const picked = tourRooms(scene, lvl.id);
    if (lvl === levels[levels.length - 1]) picked.sort((a, c) => Number(isOutdoorRoom(a)) - Number(isOutdoorRoom(c)));
    for (const r of picked) {
      const cam = roomCamera(scene, r);
      const dist = Math.hypot(cam.lookX - cam.x, cam.lookY - cam.y) || 1;
      const dir = { x: (cam.lookX - cam.x) / dist, y: (cam.lookY - cam.y) / dist }; // plan direction of the view
      // a slow push-in of up to 0.8 m (never past the halfway point to what it looks at), with a gentle pan
      let step = Math.min(0.8, dist * 0.3);
      while (step > 0.1 && !pointInPolygon({ x: cam.x + dir.x * step, y: cam.y + dir.y * step }, r.polygon)) step *= 0.6;
      const eye = r.centroid.y + 1.6;
      const E = r.centroid.y;
      const key = (k: number, sweep: number): CamKey => {
        const px = cam.x + dir.x * step * k, py = cam.y + dir.y * step * k;
        // rotate the look point about the camera by `sweep` radians
        const lx = cam.lookX - px, ly = cam.lookY - py;
        const c = Math.cos(sweep), sn = Math.sin(sweep);
        return { pos: v3(px, eye, -py), target: v3(px + lx * c - ly * sn, E + cam.lookH, -(py + lx * sn + ly * c)) };
      };
      const size = r.documentedAreaM2 !== undefined ? `${r.documentedAreaM2.toFixed(1)} m² as printed` : `about ${r.computedAreaM2.toFixed(0)} m² traced from the plan`;
      const outdoor = isOutdoorRoom(r);
      shots.push({
        kind: "room", title: r.name, subtitle: `${lvl.name} · ${size}`, levels: all, ceilings: true, duration: 4.5, fov: outdoor ? 58 : 64,
        roomId: r.id, levelId: lvl.id, outdoor, path: [key(0, 0.08), key(0.5, 0), key(1, -0.08)],
      });
    }
  }

  shots.push({
    kind: "exterior", title: scene.title, subtitle: "Modelled from the brochure's plans and renders. Furniture is illustrative; not a survey.",
    levels: shown.map((l) => l.id), ceilings: true, duration: 5, fov: 40,
    path: [0, 1].map((k) => orbit(a0 + 0.9 + k * 0.5, R * (1.05 + 0.35 * k), base + size * (0.45 + 0.35 * k), base + (top - base) * 0.3)),
  });
  return shots;
}

export function tourDuration(shots: TourShot[]) {
  return shots.reduce((s, x) => s + x.duration, 0);
}

const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** Where the camera is at time t (seconds), which shot is on, and how dark the fade is (0..1). */
export function tourAt(shots: TourShot[], t: number): { index: number; cam: CamKey; fade: number; local: number } {
  let acc = 0;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (t < acc + s.duration || i === shots.length - 1) {
      const local = Math.max(0, Math.min(s.duration, t - acc));
      const u = ease(local / s.duration);
      const n = s.path.length - 1;
      const seg = Math.min(n - 1, Math.floor(u * n));
      const k = n > 0 ? u * n - seg : 0;
      const a = s.path[Math.max(0, seg)], b = s.path[Math.min(n, seg + 1)];
      const cam = n > 0 ? { pos: lerp(a.pos, b.pos, k), target: lerp(a.target, b.target, k) } : s.path[0];
      const fin = i === 0 ? 1 : Math.min(1, local / FADE_S);
      const fout = Math.min(1, (s.duration - local) / FADE_S);
      return { index: i, cam, fade: 1 - Math.min(fin, fout), local };
    }
    acc += s.duration;
  }
  return { index: 0, cam: shots[0].path[0], fade: 0, local: 0 };
}
