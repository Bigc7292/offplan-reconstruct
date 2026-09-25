// Material resolution: dossier Material → renderable PBR parameters.
// A material is used exactly as documented when its albedoHint is a hex colour;
// otherwise the name/hint is mapped to a PBR approximation (flagged in the UI).
import type { Material, PropertyDossier, Room, SceneMaterial, Surface } from "./schema";
import { isInferred } from "./schema";

type Pbr = { color: string; roughness: number; metalness: number; opacity?: number };

// Ordered: first keyword match wins, so put specific names before generic ones.
const NAME_TABLE: Array<[RegExp, Pbr]> = [
  [/calacatta|statuario|carrara|white marble/i, { color: "#ece8e1", roughness: 0.25, metalness: 0 }],
  [/emperador|brown marble/i, { color: "#6e5443", roughness: 0.3, metalness: 0 }],
  [/nero|black marble|marquina/i, { color: "#232323", roughness: 0.25, metalness: 0 }],
  [/onyx/i, { color: "#e7d9bd", roughness: 0.2, metalness: 0 }],
  [/marble/i, { color: "#e4ded4", roughness: 0.3, metalness: 0 }],
  [/travertine/i, { color: "#d6c7ad", roughness: 0.6, metalness: 0 }],
  [/limestone|stone/i, { color: "#d6cdbd", roughness: 0.55, metalness: 0 }],
  [/terrazzo/i, { color: "#d9d3ca", roughness: 0.45, metalness: 0 }],
  [/porcelain|ceramic|tile/i, { color: "#cfc9c0", roughness: 0.5, metalness: 0 }],
  [/concrete|cement|microcement/i, { color: "#a8a39b", roughness: 0.85, metalness: 0 }],
  [/walnut/i, { color: "#5b3f2b", roughness: 0.55, metalness: 0 }],
  [/oak/i, { color: "#a07b55", roughness: 0.6, metalness: 0 }],
  [/teak/i, { color: "#8b6239", roughness: 0.6, metalness: 0 }],
  [/ash|maple|birch/i, { color: "#c8ab86", roughness: 0.6, metalness: 0 }],
  [/wood|timber|veneer|parquet|herringbone/i, { color: "#9a7652", roughness: 0.6, metalness: 0 }],
  [/champagne|brushed brass/i, { color: "#c2a878", roughness: 0.35, metalness: 1 }],
  [/brass|gold/i, { color: "#b89355", roughness: 0.3, metalness: 1 }],
  [/bronze/i, { color: "#7c5c3b", roughness: 0.35, metalness: 0.9 }],
  [/copper/i, { color: "#b0704a", roughness: 0.35, metalness: 1 }],
  [/chrome|stainless|steel|aluminium|aluminum/i, { color: "#b7bbbf", roughness: 0.25, metalness: 1 }],
  [/black metal|matte black/i, { color: "#26262a", roughness: 0.5, metalness: 0.8 }],
  [/glass|glazing/i, { color: "#a9c3c9", roughness: 0.05, metalness: 0.1, opacity: 0.25 }],
  [/mirror/i, { color: "#dfe6ea", roughness: 0.02, metalness: 1 }],
  [/leather/i, { color: "#6b4b36", roughness: 0.55, metalness: 0 }],
  [/linen|fabric|boucl|velvet|upholster/i, { color: "#ddd5c8", roughness: 0.95, metalness: 0 }],
  [/plaster|paint|render/i, { color: "#ece8e1", roughness: 0.9, metalness: 0 }],
  [/grass|lawn/i, { color: "#6f8f4e", roughness: 1, metalness: 0 }],
  [/water|pool/i, { color: "#5fb3c9", roughness: 0.05, metalness: 0, opacity: 0.7 }],
];

const COLOR_WORDS: Record<string, string> = {
  white: "#efece6", ivory: "#eee6d3", cream: "#e9dfc9", beige: "#d9ccb4", sand: "#d4c4a4", taupe: "#9e8f80",
  grey: "#9b9a97", gray: "#9b9a97", charcoal: "#3b3b3d", black: "#222222", brown: "#6c4d35", greige: "#b7ad9f",
  champagne: "#d8c49a", gold: "#c9a45c", bronze: "#7c5c3b", green: "#6d7f5e", blue: "#5b7087", navy: "#26344a",
};

export const FALLBACKS: Record<string, SceneMaterial> = {
  "auto:wall": { id: "auto:wall", name: "Wall (default — no finish documented)", color: "#e9e5de", roughness: 0.9, metalness: 0, opacity: 1, inferred: true },
  "auto:floor": { id: "auto:floor", name: "Floor (default — no finish documented)", color: "#cbc3b6", roughness: 0.7, metalness: 0, opacity: 1, inferred: true },
  "auto:ceiling": { id: "auto:ceiling", name: "Ceiling (default)", color: "#f2f0eb", roughness: 0.95, metalness: 0, opacity: 1, inferred: true },
  "auto:glass": { id: "auto:glass", name: "Glazing (default)", color: "#a9c3c9", roughness: 0.05, metalness: 0.1, opacity: 0.25, inferred: true },
  "auto:frame": { id: "auto:frame", name: "Frame (default)", color: "#4a4a4c", roughness: 0.4, metalness: 0.8, opacity: 1, inferred: true },
  "auto:slab": { id: "auto:slab", name: "Structural slab (default)", color: "#9d9890", roughness: 0.9, metalness: 0, opacity: 1, inferred: true },
  "auto:door": { id: "auto:door", name: "Door leaf (default)", color: "#d9d2c6", roughness: 0.6, metalness: 0, opacity: 1, inferred: true },
  "auto:fabric": { id: "auto:fabric", name: "Soft furnishing (illustrative)", color: "#cfc8bd", roughness: 0.95, metalness: 0, opacity: 1, inferred: true },
  "auto:cushion": { id: "auto:cushion", name: "Cushion fabric (illustrative)", color: "#a89a86", roughness: 0.95, metalness: 0, opacity: 1, inferred: true },
  "auto:linen": { id: "auto:linen", name: "Bed linen (illustrative)", color: "#f1eee8", roughness: 0.9, metalness: 0, opacity: 1, inferred: true },
  "auto:throw": { id: "auto:throw", name: "Throw fabric (illustrative)", color: "#8c7b68", roughness: 0.95, metalness: 0, opacity: 1, inferred: true },
  "auto:timber": { id: "auto:timber", name: "Dark timber legs (illustrative)", color: "#3d332c", roughness: 0.5, metalness: 0, opacity: 1, inferred: true },
  "auto:metal": { id: "auto:metal", name: "Brushed metal fittings (illustrative)", color: "#b9b2a6", roughness: 0.3, metalness: 1, opacity: 1, inferred: true },
  "auto:ceramic": { id: "auto:ceramic", name: "Sanitaryware proxy", color: "#f4f3f0", roughness: 0.2, metalness: 0, opacity: 1, inferred: true },
  "auto:water": { id: "auto:water", name: "Pool water", color: "#3fa7bf", roughness: 0.05, metalness: 0.1, opacity: 0.85, inferred: true },
  "auto:joinery": { id: "auto:joinery", name: "Joinery proxy (default)", color: "#a58a6c", roughness: 0.6, metalness: 0, opacity: 1, inferred: true },
};

export function toPbr(m: Material): { pbr: Pbr; approximated: boolean } {
  const hint = m.albedoHint.trim();
  const isGlass = m.appliedTo.includes("glass") || /glass|glazing/i.test(m.name);
  if (/^#[0-9a-f]{6}$/i.test(hint)) {
    return { pbr: { color: hint.toLowerCase(), roughness: m.roughness, metalness: m.metalness, opacity: isGlass ? 0.25 : 1 }, approximated: false };
  }
  const text = `${m.name} ${hint}`;
  for (const [re, pbr] of NAME_TABLE) if (re.test(text)) return { pbr: { ...pbr, roughness: m.roughness ?? pbr.roughness, metalness: m.metalness ?? pbr.metalness }, approximated: true };
  for (const [w, c] of Object.entries(COLOR_WORDS)) if (new RegExp(`\\b${w}\\b`, "i").test(text)) return { pbr: { color: c, roughness: m.roughness, metalness: m.metalness }, approximated: true };
  return { pbr: { color: "#cfc8bc", roughness: m.roughness, metalness: m.metalness }, approximated: true };
}

export function sceneMaterialFor(m: Material, textureAssetPath?: string): SceneMaterial {
  const { pbr, approximated } = toPbr(m);
  return {
    id: m.id,
    name: m.name + (approximated ? " (PBR approximation)" : ""),
    color: pbr.color,
    roughness: pbr.roughness,
    metalness: pbr.metalness,
    opacity: pbr.opacity ?? 1,
    textureAssetPath,
    inferred: isInferred(m.evidence),
  };
}

/**
 * Pick the dossier material for a surface of a room. Room-bound materials beat
 * program-bound ones, which beat unbound ones. Returns undefined when nothing
 * documented applies (the builder then uses a flagged default).
 */
export function resolveMaterial(d: PropertyDossier, surface: Surface, room?: Room): Material | undefined {
  const cands = d.materials.filter((m) => m.appliedTo.includes(surface));
  if (room) {
    const byRoom = cands.find((m) => m.roomIds?.includes(room.id));
    if (byRoom) return byRoom;
    if (room.materialSetId) {
      const bySet = cands.find((m) => m.id === room.materialSetId || m.id.startsWith(`${room.materialSetId}/`));
      if (bySet) return bySet;
    }
    const byProgram = cands.find((m) => m.programs?.includes(room.program));
    if (byProgram) return byProgram;
  }
  return cands.find((m) => !m.roomIds?.length && !m.programs?.length);
}
