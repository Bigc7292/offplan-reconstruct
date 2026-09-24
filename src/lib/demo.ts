// Built-in DEMO unit: a generic Dubai-style off-plan 2BR + maid apartment.
// It is NOT an extracted project. Every element carries demo evidence and the UI
// labels the job "DEMO" everywhere so it is never confused with a real brochure.
import type { Evidence, Level, Material, Opening, PropertyDossier, Room, Wall, Furniture } from "./schema";
import { polygonArea, round } from "./geom";

const DEMO_REF = "demo:sample-plan";
export const DEMO_PLAN_PATH = "/samples/demo-unit-plan.svg";
export const DEMO_PLAN_PX_PER_M = 60;
export const DEMO_PLAN_ORIGIN = { x: 80, y: 80 + 8.6 * 60 }; // image px of plan (0,0); plan spans y -2..8.6

function ev(quote: string, confidence = 1): Evidence[] {
  return [{ source: "user", ref: DEMO_REF, quote: `DEMO · ${quote}`, confidence }];
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

type RoomDef = [id: string, name: string, program: string, x0: number, y0: number, x1: number, y1: number];
const ROOMS: RoomDef[] = [
  ["r-living", "Living / Dining", "living", 0, 0, 6.4, 4.8],
  ["r-kitchen", "Kitchen", "kitchen", 0, 4.8, 3.2, 8.6],
  ["r-corridor", "Corridor", "circulation", 3.2, 4.8, 9.6, 6.0],
  ["r-entry", "Entrance Foyer", "circulation", 3.2, 6.0, 5.0, 8.6],
  ["r-maid", "Maid", "bedroom", 5.0, 6.0, 7.2, 8.6],
  ["r-laundry", "Laundry", "storage", 7.2, 6.0, 8.2, 8.6],
  ["r-bath2", "Bathroom", "bath", 8.2, 6.0, 9.6, 8.6],
  ["r-bed2", "Bedroom 2", "bedroom", 6.4, 0, 9.6, 4.8],
  ["r-master", "Master Bedroom", "bedroom", 9.6, 0, 13.4, 4.8],
  ["r-walkin", "Walk-in Wardrobe", "storage", 9.6, 4.8, 11.2, 8.6],
  ["r-ensuite", "Master En-suite", "bath", 11.2, 4.8, 13.4, 8.6],
  ["r-balcony", "Balcony", "balcony", 0, -2.0, 6.2, 0],
];

type OpeningDef = [kind: Opening["kind"], atM: number, widthM: number, heightM: number, sillM?: number];
type WallDef = [id: string, ax: number, ay: number, bx: number, by: number, kind: Wall["kind"], openings: OpeningDef[]];

const WALLS: WallDef[] = [
  // exterior envelope (a→b runs anticlockwise from the south-west corner)
  ["w-s-living", 0, 0, 6.4, 0, "glass", [["sliding_door", 3.1, 2.4, 2.7]]],
  ["w-s-bed2", 6.4, 0, 9.6, 0, "exterior", [["window", 1.6, 2.2, 2.3, 0.3]]],
  ["w-s-master", 9.6, 0, 13.4, 0, "exterior", [["window", 1.9, 2.6, 2.3, 0.3]]],
  ["w-east", 13.4, 0, 13.4, 8.6, "exterior", [["window", 2.4, 1.6, 2.0, 0.6], ["window", 6.7, 0.8, 0.9, 1.5]]],
  ["w-north", 13.4, 8.6, 0, 8.6, "exterior", [["door", 9.3, 1.0, 2.4]]],
  ["w-west", 0, 8.6, 0, 0, "exterior", [["window", 1.6, 1.2, 1.1, 1.1], ["window", 6.2, 2.4, 2.3, 0.3]]],
  // interior partitions
  ["w-living-bed2", 6.4, 0, 6.4, 4.8, "interior", []],
  ["w-bed2-master", 9.6, 0, 9.6, 4.8, "interior", []],
  ["w-bed2-corr", 6.4, 4.8, 9.6, 4.8, "interior", [["door", 0.6, 0.9, 2.2]]],
  ["w-master-north", 9.6, 4.8, 13.4, 4.8, "interior", [["opening", 0.8, 0.9, 2.2]]],
  ["w-kitchen-entry", 3.2, 6.0, 3.2, 8.6, "interior", []],
  ["w-corr-north", 5.0, 6.0, 9.6, 6.0, "interior", [["door", 0.6, 0.8, 2.2], ["door", 2.7, 0.7, 2.2], ["door", 3.9, 0.8, 2.2]]],
  ["w-entry-maid", 5.0, 6.0, 5.0, 8.6, "interior", []],
  ["w-maid-laundry", 7.2, 6.0, 7.2, 8.6, "partition", []],
  ["w-laundry-bath", 8.2, 6.0, 8.2, 8.6, "partition", []],
  ["w-corr-walkin", 9.6, 4.8, 9.6, 8.6, "interior", [["door", 0.6, 0.9, 2.2]]],
  ["w-walkin-ensuite", 11.2, 4.8, 11.2, 8.6, "interior", [["door", 0.8, 0.8, 2.2]]],
  // balcony railings
  ["w-bal-west", 0, 0, 0, -2.0, "railing", []],
  ["w-bal-south", 0, -2.0, 6.2, -2.0, "railing", []],
  ["w-bal-east", 6.2, -2.0, 6.2, 0, "railing", []],
];

const CEILING = 3.0;

type FurnDef = [id: string, kind: Furniture["kind"], cx: number, cy: number, w: number, d: number, h: number, rot: number, roomId: string];
const FURNITURE: FurnDef[] = [
  ["f-sofa", "sofa", 1.9, 1.3, 2.8, 0.95, 0.8, 0, "r-living"],
  ["f-armchair", "armchair", 3.9, 2.1, 0.85, 0.85, 0.8, -90, "r-living"],
  ["f-dining", "dining", 4.6, 3.6, 1.9, 1.0, 0.76, 0, "r-living"],
  ["f-kitchen-run", "kitchen_run", 0.33, 6.7, 0.65, 3.4, 0.92, 0, "r-kitchen"],
  ["f-island", "island", 1.9, 6.3, 0.9, 2.0, 0.92, 0, "r-kitchen"],
  ["f-bed-master", "bed_double", 11.5, 2.9, 1.9, 2.15, 0.55, 0, "r-master"],
  ["f-bed-2", "bed_double", 8.0, 2.8, 1.65, 2.1, 0.55, 0, "r-bed2"],
  ["f-wardrobe-2", "wardrobe", 8.0, 4.45, 2.4, 0.6, 2.4, 0, "r-bed2"],
  ["f-walkin-l", "wardrobe", 9.95, 6.9, 0.6, 3.2, 2.4, 0, "r-walkin"],
  ["f-bath-ensuite", "bath", 12.3, 8.2, 1.7, 0.75, 0.6, 0, "r-ensuite"],
  ["f-vanity-ensuite", "vanity", 13.1, 6.2, 0.55, 1.6, 0.85, 0, "r-ensuite"],
  ["f-bed-maid", "bed_single", 6.1, 7.6, 0.95, 1.95, 0.5, 0, "r-maid"],
];

export function buildDemoDossier(jobId: string): PropertyDossier {
  const rooms: Room[] = ROOMS.map(([id, name, program, x0, y0, x1, y1]) => {
    const polygon = rect(x0, y0, x1, y1);
    return {
      id, name, program, polygon,
      areaM2: round(polygonArea(polygon), 2),
      ceilingHeightM: program === "balcony" ? undefined : CEILING,
      levelId: "L-demo",
      adjacentRoomIds: [],
      evidence: ev(`${name} ${round(x1 - x0, 2).toFixed(2)} × ${round(y1 - y0, 2).toFixed(2)} m`),
    };
  });

  const walls: Wall[] = WALLS.map(([id, ax, ay, bx, by, kind, ops]) => {
    const L = Math.hypot(bx - ax, by - ay);
    return {
      id,
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      thicknessM: kind === "exterior" || kind === "glass" ? 0.2 : kind === "railing" ? 0.06 : kind === "partition" ? 0.1 : 0.12,
      heightM: kind === "railing" ? 1.1 : CEILING,
      kind,
      materialId: kind === "railing" || kind === "glass" ? "m-glass" : "m-wall",
      openings: ops.map(([okind, atM, widthM, heightM, sillM], i) => ({
        id: `${id}-o${i + 1}`,
        kind: okind,
        wallId: id,
        offset: round(atM / L, 4),
        widthM, heightM, sillM,
        evidence: ev(`${okind.replace("_", " ")} ${widthM.toFixed(2)} m`),
      })),
      evidence: ev(`wall ${L.toFixed(2)} m`),
    };
  });

  const furniture: Furniture[] = FURNITURE.map(([id, kind, cx, cy, w, d, h, rot, roomId]) => ({
    id, kind, center: { x: cx, y: cy }, sizeM: { w, d, h }, rotationDeg: rot, roomId, evidence: ev(`${kind} proxy`),
  }));

  const level: Level = {
    id: "L-demo",
    name: "Level 22 (DEMO)",
    elevationM: 0,
    heightM: CEILING,
    rooms,
    walls,
    furniture,
    unitTypeId: "ut-demo",
    plan: {
      assetId: "a-demo-plan",
      imagePath: DEMO_PLAN_PATH,
      imageW: 80 * 2 + 13.4 * DEMO_PLAN_PX_PER_M,
      imageH: 80 * 2 + 10.6 * DEMO_PLAN_PX_PER_M + 20,
      pxPerM: DEMO_PLAN_PX_PER_M,
      originPx: DEMO_PLAN_ORIGIN,
      scaleConfidence: 1,
      evidence: ev("scale bar 0-5 m"),
    },
  };

  const materials: Material[] = [
    mat("m-floor-stone", "Pale limestone (DEMO)", "#d8d0c2", 0.55, 0, ["floor"], { programs: ["living", "kitchen", "circulation", "bedroom", "storage"] }),
    mat("m-floor-wet", "Honed marble (DEMO)", "#e6e1d8", 0.35, 0, ["floor", "wall"], { programs: ["bath"] }),
    mat("m-floor-balcony", "Porcelain deck tile (DEMO)", "#b9b1a4", 0.8, 0, ["floor"], { programs: ["balcony"] }),
    mat("m-wall", "Warm white paint (DEMO)", "#eeeae3", 0.9, 0, ["wall", "ceiling"]),
    mat("m-joinery", "Warm oak joinery (DEMO)", "#8a6a4b", 0.6, 0, ["joinery"]),
    mat("m-counter", "Quartz counter (DEMO)", "#efeee9", 0.3, 0, ["counter"]),
    mat("m-bronze", "Bronze hardware (DEMO)", "#7c5c3b", 0.35, 0.9, ["joinery"], { programs: ["hardware"] }),
    mat("m-glass", "Full-height glass (DEMO)", "#a9c3c9", 0.05, 0.1, ["glass"]),
  ];

  return {
    jobId,
    demo: true,
    projectName: "DEMO — Sample Off-Plan Tower",
    developer: "DEMO (no developer)",
    location: "DEMO — Dubai (illustrative)",
    unitFocus: "Type C · 2BR + Maid · Level 22 (DEMO)",
    copy: [
      "DEMO UNIT. This sample is generated by the app so the viewer can be tried without a brochure. It does not describe any real project.",
      "Two bedrooms plus maid's room, open living and dining with full-height glazing onto a south-facing balcony.",
      "Finishes shown: pale stone floors, warm wood joinery, bronze hardware, full-height glass.",
    ],
    facts: [
      { key: "unit.type", value: "Type C · 2BR + Maid", evidence: ev("Type C") },
      { key: "area.suite_m2", value: "108.5", evidence: ev("Suite 108.5 m²") },
      { key: "area.balcony_m2", value: "12.4", evidence: ev("Balcony 12.4 m²") },
      { key: "area.total_m2", value: "120.9", evidence: ev("Total 120.9 m²") },
      { key: "ceiling_height_m", value: "3.0", evidence: ev("3.0 m ceiling height") },
      { key: "orientation", value: "Living and balcony face south", evidence: ev("south facing living") },
    ],
    unitTypes: [
      { id: "ut-demo", code: "Type C (DEMO)", beds: 2, baths: 2, suiteAreaM2: 108.5, balconyAreaM2: 12.4, totalAreaM2: 120.9, levelIds: ["L-demo"], primaryPlanAssetId: "a-demo-plan" },
    ],
    selectedUnitTypeId: "ut-demo",
    levels: [level],
    materials,
    assets: [{ id: "a-demo-plan", kind: "unit_plan", path: DEMO_PLAN_PATH, caption: "DEMO unit plan", unitTypeIds: ["ut-demo"] }],
    warnings: [
      "DEMO unit — generated sample, not extracted from any brochure.",
      "Room areas are measured to wall centre-lines; the documented suite area (108.5 m²) is a net internal figure.",
    ],
    completeness: { hasPlan: true, hasScale: true, hasDimensions: true, hasCgi: false, hasFinishSchedule: true },
    northDeg: 0,
  };
}

function mat(
  id: string, name: string, hex: string, roughness: number, metalness: number, appliedTo: Material["appliedTo"],
  bind: Partial<Pick<Material, "programs" | "roomIds">> = {},
): Material {
  return { id, name, albedoHint: hex, roughness, metalness, mapsFromAssetIds: [], appliedTo, evidence: ev(name), ...bind };
}
