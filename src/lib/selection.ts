// Client-safe helpers shared by the builder and the UI.
import type { Level, PropertyDossier } from "./schema";

/** Levels of the selected unit type (all levels when no unit type is chosen). */
export function levelsForSelection(d: PropertyDossier): Level[] {
  const ut = d.unitTypes.find((u) => u.id === d.selectedUnitTypeId);
  if (!ut) return d.levels;
  const lv = d.levels.filter((l) => ut.levelIds.includes(l.id) || l.unitTypeId === ut.id);
  return lv.length ? lv : d.levels;
}
