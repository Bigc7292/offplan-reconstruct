// Dossier hygiene applied on every save: adjacency, rounding to millimetres, completeness flags.
// Never changes documented values (areas, dimensions); only derived fields.
import type { PropertyDossier } from "./schema";
import { isInferred } from "./schema";
import { round, sharedEdgeLength } from "./geom";

export function normalizeDossier(d: PropertyDossier): PropertyDossier {
  const levels = d.levels.map((l) => {
    const rooms = l.rooms.map((r) => ({ ...r, polygon: r.polygon.map((p) => ({ x: round(p.x), y: round(p.y) })) }));
    for (const r of rooms) {
      r.adjacentRoomIds = rooms
        .filter((o) => o.id !== r.id && r.polygon.length >= 3 && o.polygon.length >= 3 && sharedEdgeLength(r.polygon, o.polygon) > 0.4)
        .map((o) => o.id);
    }
    const walls = l.walls.map((w) => ({
      ...w,
      a: { x: round(w.a.x), y: round(w.a.y) },
      b: { x: round(w.b.x), y: round(w.b.y) },
      openings: w.openings.map((o) => ({ ...o, wallId: w.id, offset: Math.min(1, Math.max(0, round(o.offset, 4))) })),
    }));
    return { ...l, rooms, walls };
  });
  const placedRooms = levels.flatMap((l) => l.rooms).filter((r) => r.polygon.length >= 3);
  const hasPlan = d.assets.some((a) => ["floor_plan", "unit_plan", "key_plan"].includes(a.kind)) || placedRooms.length > 0;
  const hasScale = levels.some((l) => (l.plan?.scaleConfidence ?? 0) >= 0.5);
  const hasDimensions = levels.some((l) => l.rooms.some((r) => r.evidence.some((e) => /\d+(\.\d+)?\s*[x×]\s*\d/i.test(e.quote ?? ""))) || l.walls.some((w) => !isInferred(w.evidence)));
  const hasCgi = d.assets.some((a) => a.kind === "cgi_interior" || a.kind === "cgi_exterior");
  const hasFinishSchedule = d.materials.some((m) => !isInferred(m.evidence) && m.evidence.some((e) => e.confidence >= 0.6));
  return { ...d, levels, completeness: { hasPlan, hasScale, hasDimensions, hasCgi, hasFinishSchedule } };
}
