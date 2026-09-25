// Material resolution: dossier Material → renderable PBR parameters.
// A material is used exactly as documented when its albedoHint is a hex colour;
// otherwise the name/hint is mapped to a PBR approximation (flagged in the UI).
import type { Material, MaterialRole, PropertyDossier, Room, SceneMaterial, Surface } from "./schema";
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

const fb = (id: string, name: string, color: string, roughness: number, metalness = 0, opacity = 1, extra: Partial<SceneMaterial> = {}): [string, SceneMaterial] =>
  [id, { id, name, color, roughness, metalness, opacity, inferred: true, ...extra }];

/** Finishes the brochure does not document. Named for what they are, marked illustrative (assumed) in the UI. */
export const FALLBACKS: Record<string, SceneMaterial> = Object.fromEntries([
  fb("auto:wall", "Painted plaster (assumed)", "#ebe6de", 0.9),
  fb("auto:facade", "White facade render (assumed)", "#efebe4", 0.85),
  fb("auto:cap", "Wall section (cut line)", "#3a3631", 0.9),
  fb("auto:floor", "Porcelain floor (assumed)", "#d6cfc4", 0.55),
  fb("auto:ceiling", "Painted ceiling (assumed)", "#f3f1ec", 0.95),
  fb("auto:glass", "Clear glazing", "#b7ccd1", 0.04, 0.1, 0.22),
  fb("auto:frame", "Dark bronze frames (assumed)", "#2b2a29", 0.45, 0.7),
  fb("auto:slab", "Structural slab", "#9d9890", 0.9),
  fb("auto:door", "Oak door leaf (assumed)", "#b89a78", 0.6),
  fb("auto:fabric", "Upholstery (illustrative)", "#d7cfc2", 0.95),
  fb("auto:cushion", "Cushion fabric (illustrative)", "#b3a58f", 0.95),
  fb("auto:accent", "Accent cushion (illustrative)", "#8a6f55", 0.95),
  fb("auto:linen", "Bed linen (illustrative)", "#f3f0ea", 0.9),
  fb("auto:throw", "Throw (illustrative)", "#8c7b68", 0.95),
  fb("auto:timber", "Dark timber (illustrative)", "#4a3a2e", 0.5),
  fb("auto:teak", "Teak (illustrative)", "#8b6239", 0.6),
  fb("auto:metal", "Brushed metal (illustrative)", "#b9b2a6", 0.3, 1),
  fb("auto:black", "Black metal (illustrative)", "#1f1f21", 0.45, 0.6),
  fb("auto:mirror", "Mirror", "#dfe6ea", 0.03, 1),
  fb("auto:ceramic", "White sanitaryware", "#f4f3f0", 0.18),
  fb("auto:stone", "Stone top (illustrative)", "#e4ded4", 0.3),
  fb("auto:rug", "Wool rug (illustrative)", "#c9bca8", 1),
  fb("auto:curtain", "Sheer curtain (illustrative)", "#efe9df", 0.95, 0, 0.82),
  fb("auto:pot", "Planter (illustrative)", "#6e6a63", 0.7),
  fb("auto:leaf", "Planting (illustrative)", "#5b7a3e", 0.9),
  fb("auto:hedge", "Hedge (illustrative)", "#4f6e35", 1),
  fb("auto:trunk", "Tree trunk (illustrative)", "#5d4a39", 0.9),
  fb("auto:palmtrunk", "Palm trunk (illustrative)", "#8a7560", 0.9),
  fb("auto:water", "Pool water", "#2fa3bd", 0.03, 0.1, 0.78),
  fb("auto:pooltile", "Pool mosaic (assumed)", "#1d9fb6", 0.3),
  fb("auto:coping", "Stone coping (assumed)", "#d8d0c4", 0.6),
  fb("auto:joinery", "Joinery (assumed)", "#a58a6c", 0.6),
  fb("auto:soffit", "Slab soffit, painted (assumed)", "#f1ede6", 0.9),
  fb("auto:fascia", "Slab edge (assumed)", "#3b3835", 0.6),
  fb("auto:roof", "Roof membrane (assumed)", "#bdb7ad", 0.95),
  fb("auto:paving", "Stone paving (assumed)", "#d6cec4", 0.8),
  fb("auto:lawn", "Lawn (illustrative)", "#6f9a4c", 1),
  fb("auto:boundary", "Boundary wall, render (assumed)", "#e6e0d6", 0.9),
  fb("auto:gate", "Metal gate (assumed)", "#2d2c2b", 0.5, 0.6),
  fb("auto:stair", "Stone stair (assumed)", "#e3ddd3", 0.45),
  fb("auto:concrete", "Concrete (assumed)", "#a8a39b", 0.85),
  fb("auto:bayline", "Parking bay marking", "#f2f2ee", 0.6),
  fb("auto:asphalt", "Driveway (assumed)", "#5a5854", 0.9),
  fb("auto:carpaint1", "Car (illustrative)", "#1c1d20", 0.25, 0.6),
  fb("auto:carpaint2", "Car (illustrative)", "#d9d9d6", 0.25, 0.6),
  fb("auto:carpaint3", "Car (illustrative)", "#4b4f55", 0.25, 0.6),
  fb("auto:carpaint4", "Car (illustrative)", "#26344a", 0.25, 0.6),
  fb("auto:tyre", "Tyres (illustrative)", "#161616", 0.8),
  fb("auto:carglass", "Car glass (illustrative)", "#1a2126", 0.05, 0.3),
  fb("auto:outdoor", "Outdoor cushion (illustrative)", "#e8e2d6", 0.95),
  fb("auto:screen", "Timber slat screen (assumed)", "#9a7350", 0.65),
  fb("auto:pergola", "Pergola (assumed)", "#3a3633", 0.55, 0.3),
  fb("auto:light", "Light fitting (illustrative)", "#fff3dc", 0.5, 0, 1, { emissive: "#ffd9a0", emissiveIntensity: 1.1 }),
  fb("auto:fire", "Fire pit flame (illustrative)", "#ff9a3c", 0.5, 0, 1, { emissive: "#ff7a1c", emissiveIntensity: 3 }),
]);

/** Which documented exterior role serves each builder role. */
export const ROLE_OF: Record<string, MaterialRole> = {
  facade: "facade_wall", fascia: "slab_edge", soffit: "soffit", frame: "window_frame", screen: "screen", pergola: "pergola",
  balustrade: "balustrade", roof: "roof", paving: "paving", lawn: "lawn", boundary: "boundary_wall", gate: "gate",
  coping: "pool_coping", water: "pool_water", asphalt: "driveway",
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
