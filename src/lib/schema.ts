// Core data model. The dossier is the source of truth; the 3D builder reads only
// PropertyDossier (via reconstruct.ts → PropertySceneGraph) and never calls a model.
//
// The types marked "spec" follow the product spec field-for-field. A few optional
// fields are added where the pipeline needs them (plan calibration for the 2D
// overlay, furniture proxies); each one is marked "extension".
import { z } from "zod";

// ───────────────────────── spec types ─────────────────────────

export const EvidenceSchema = z.object({
  source: z.enum(["pdf", "url", "image", "user"]),
  ref: z.string(), // page-12, url#hero, asset hash. Refs starting "inferred:" mark defaults.
  quote: z.string().optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), // page-normalised 0-1 [x0,y0,x1,y1]
  confidence: z.number().min(0).max(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const Vec2Schema = z.object({ x: z.number(), y: z.number() }); // metres, plan space
export type Vec2 = z.infer<typeof Vec2Schema>;
export const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3Schema>;

export const OpeningSchema = z.object({
  id: z.string(),
  kind: z.enum(["door", "sliding_door", "window", "opening", "null"]),
  wallId: z.string(),
  offset: z.number().min(0).max(1), // centre of the opening, 0-1 along the wall a→b
  widthM: z.number().positive(),
  heightM: z.number().positive(),
  sillM: z.number().optional(),
  evidence: z.array(EvidenceSchema),
});
export type Opening = z.infer<typeof OpeningSchema>;

export const WallSchema = z.object({
  id: z.string(),
  a: Vec2Schema,
  b: Vec2Schema,
  thicknessM: z.number().positive(),
  heightM: z.number().positive(),
  kind: z.enum(["exterior", "interior", "railing", "glass", "partition"]),
  materialId: z.string().optional(),
  openings: z.array(OpeningSchema),
  evidence: z.array(EvidenceSchema),
});
export type Wall = z.infer<typeof WallSchema>;

/** Furniture the plan reader can name; the builder draws each as a recognisable, generic piece. */
export const PLAN_FURNITURE_KINDS = [
  "bed_double", "bed_single", "sofa", "dining", "kitchen_run", "island", "wardrobe", "bath", "wc", "vanity", "desk", "armchair",
  "coffee_table", "side_table", "rug", "media_unit", "ottoman", "lounger", "bench", "planter", "car", "shower", "bbq", "other",
] as const;
/** ...plus pieces only the builder adds when it dresses a room (always marked illustrative). */
export const FURNITURE_KINDS = [...PLAN_FURNITURE_KINDS, "stool", "floor_lamp", "mirror", "dresser"] as const;
export type FurnitureKind = (typeof FURNITURE_KINDS)[number];

export const FurnitureSchema = z.object({
  // extension: FF&E proxy, only emitted when the brochure shows a furniture layout
  id: z.string(),
  kind: z.enum(FURNITURE_KINDS),
  center: Vec2Schema,
  sizeM: z.object({ w: z.number(), d: z.number(), h: z.number() }),
  rotationDeg: z.number(),
  roomId: z.string().optional(),
  evidence: z.array(EvidenceSchema),
});
export type Furniture = z.infer<typeof FurnitureSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  program: z.string(), // bedroom | living | kitchen | bath | balcony | circulation | storage | amenity | other
  polygon: z.array(Vec2Schema), // closed (last point implicitly joins first), metres
  areaM2: z.number().optional(), // from docs if present, else computed
  printedDims: z.string().optional(), // extension: the width × length printed on the plan, e.g. "6.9 X 4.8"
  ceilingHeightM: z.number().optional(),
  levelId: z.string(),
  adjacentRoomIds: z.array(z.string()),
  materialSetId: z.string().optional(),
  evidence: z.array(EvidenceSchema),
});
export type Room = z.infer<typeof RoomSchema>;

export const PlanCalibrationSchema = z.object({
  // extension: how the source plan image maps onto plan metres (for the 2D overlay)
  assetId: z.string(),
  imagePath: z.string(), // job-relative path of the plan image
  imageW: z.number(),
  imageH: z.number(),
  pxPerM: z.number().positive(),
  originPx: z.object({ x: z.number(), y: z.number() }), // image pixel of plan (0,0) = bottom-left
  scaleConfidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
});
export type PlanCalibration = z.infer<typeof PlanCalibrationSchema>;

export const SiteSchema = z.object({
  plot: z.array(Vec2Schema).optional(), // the plot boundary
  lawn: z.array(z.array(Vec2Schema)).default([]),
  planting: z.array(z.array(Vec2Schema)).default([]), // beds, hedges and trees
  paving: z.array(z.array(Vec2Schema)).default([]),
  driveway: z.array(z.array(Vec2Schema)).default([]),
  gate: Vec2Schema.optional(), // where the plot is entered from the street
  evidence: z.array(EvidenceSchema),
});
export type Site = z.infer<typeof SiteSchema>;

export const StairSchema = z.object({
  id: z.string(),
  path: z.array(Vec2Schema), // walking line, foot first
  widthM: z.number().positive(),
  evidence: z.array(EvidenceSchema),
});
export type Stair = z.infer<typeof StairSchema>;

export const LevelSchema = z.object({
  id: z.string(),
  name: z.string(),
  elevationM: z.number(),
  heightM: z.number(),
  rooms: z.array(RoomSchema),
  walls: z.array(WallSchema),
  furniture: z.array(FurnitureSchema).optional(), // extension
  plan: PlanCalibrationSchema.optional(), // extension
  unitTypeId: z.string().optional(), // extension: which unit type this level belongs to
  /**
   * extension: "key_plans" when the level was traced from the small key plans printed beside renders (no floor
   * plan exists): each key plan is a separate group of rooms, set side by side, positions on the floor unknown.
   */
  layout: z.enum(["plan", "key_plans"]).optional(),
  /** extension: a note on how the level was read (e.g. the brochure's own label for it was wrong) */
  note: z.string().optional(),
  /** extension: the plot and its hard and soft landscaping, as drawn around the house on this level's plan */
  site: SiteSchema.optional(),
  /** extension: stairs drawn on the plan, each by its walking line from its foot on this level to the level above */
  stairs: z.array(StairSchema).optional(),
  /** extension: where a brochure render was taken from, read off the camera marker on its key plan */
  renderViews: z.array(z.object({
    page: z.number(),
    caption: z.string().optional(),
    renderAssetId: z.string().optional(),
    at: Vec2Schema,
    look: Vec2Schema,
  })).optional(),
});
export type Level = z.infer<typeof LevelSchema>;

export const SurfaceSchema = z.enum(["floor", "wall", "ceiling", "joinery", "counter", "facade", "glass"]);
export type Surface = z.infer<typeof SurfaceSchema>;

export const MATERIAL_ROLES = [
  "facade_wall", "slab_edge", "soffit", "window_frame", "screen", "pergola", "balustrade", "roof",
  "paving", "lawn", "planting", "boundary_wall", "gate", "pool_coping", "pool_water", "driveway",
] as const;
export type MaterialRole = (typeof MATERIAL_ROLES)[number];

export const MaterialSchema = z.object({
  id: z.string(),
  name: z.string(),
  albedoHint: z.string(), // hex or description
  roughness: z.number().min(0).max(1),
  metalness: z.number().min(0).max(1),
  mapsFromAssetIds: z.array(z.string()), // CGI crops used as reference
  appliedTo: z.array(SurfaceSchema),
  evidence: z.array(EvidenceSchema),
  // extensions: bind a material to specific rooms or room programs (e.g. the kitchen CGI → kitchen floor).
  // A material with neither applies to every room for its surfaces.
  roomIds: z.array(z.string()).optional(),
  programs: z.array(z.string()).optional(),
  textureAssetId: z.string().optional(), // CGI crop used as a texture when the mapping is reliable
  /** extension: what an exterior finish is for, read off the exterior renders */
  role: z.enum(MATERIAL_ROLES).optional(),
});
export type Material = z.infer<typeof MaterialSchema>;

export const AssetKindSchema = z.enum([
  "floor_plan", "unit_plan", "key_plan", "cgi_interior", "cgi_exterior", "photo",
  "material_board", "amenity", "elevation", "logo", "other",
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetSchema = z.object({
  id: z.string(),
  kind: AssetKindSchema,
  path: z.string(),
  caption: z.string().optional(),
  page: z.number().optional(),
  unitTypeIds: z.array(z.string()).optional(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const UnitTypeSchema = z.object({
  id: z.string(),
  code: z.string(),
  beds: z.number().optional(),
  baths: z.number().optional(),
  suiteAreaM2: z.number().optional(),
  balconyAreaM2: z.number().optional(),
  totalAreaM2: z.number().optional(),
  levelIds: z.array(z.string()),
  primaryPlanAssetId: z.string().optional(),
});
export type UnitType = z.infer<typeof UnitTypeSchema>;

export const FactSchema = z.object({ key: z.string(), value: z.string(), evidence: z.array(EvidenceSchema) });
export type Fact = z.infer<typeof FactSchema>;

export const ExteriorSchema = z.object({
  slabEdges: z.enum(["none", "thin", "deep"]).optional(), // floor and roof slabs showing as bands on the facade
  overhangM: z.number().optional(), // how far slabs and roofs project past the walls
  screensOn: z.array(z.string()).default([]), // names of rooms whose outside walls carry a slatted screen
  pergola: z.boolean().optional(), // a slatted pergola over the roof terrace
  storeyHeightM: z.number().optional(), // floor-to-ceiling, estimated from people and doors in the renders
  evidence: z.array(EvidenceSchema),
});
export type Exterior = z.infer<typeof ExteriorSchema>;

export const PropertyDossierSchema = z.object({
  jobId: z.string(),
  projectName: z.string().optional(),
  developer: z.string().optional(),
  location: z.string().optional(),
  unitFocus: z.string().optional(),
  copy: z.array(z.string()),
  facts: z.array(FactSchema),
  unitTypes: z.array(UnitTypeSchema),
  levels: z.array(LevelSchema),
  materials: z.array(MaterialSchema),
  assets: z.array(AssetSchema),
  warnings: z.array(z.string()),
  completeness: z.object({
    hasPlan: z.boolean(),
    hasScale: z.boolean(),
    hasDimensions: z.boolean(),
    hasCgi: z.boolean(),
    hasFinishSchedule: z.boolean(),
  }),
  // extensions
  /** how the building looks from outside, read off the exterior renders of this property */
  exterior: ExteriorSchema.optional(),
  selectedUnitTypeId: z.string().optional(),
  northDeg: z.number().optional(), // plan-space angle of north, degrees clockwise from +y
  demo: z.boolean().optional(),
  reviewedAt: z.string().optional(),
});
export type PropertyDossier = z.infer<typeof PropertyDossierSchema>;

// ───────────────────────── pipeline types ─────────────────────────

export const PAGE_LABELS = [
  "cover", "masterplan", "amenities", "typical_floor", "unit_plan", "furniture_layout", "elevation",
  "section", "cgi_interior", "cgi_exterior", "material_board", "specs_schedule", "legal_disclaimer",
  "location", "other",
] as const;
export const PageLabelSchema = z.enum(PAGE_LABELS);
export type PageLabel = z.infer<typeof PageLabelSchema>;

export const TextItemSchema = z.object({
  str: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), // page-normalised
  size: z.number().optional(),
});
export type TextItem = z.infer<typeof TextItemSchema>;

export const PageRecordSchema = z.object({
  n: z.number(), // global page number within the job (1-based)
  sourceId: z.string(),
  sourcePage: z.number(), // page number inside its source document
  image: z.string(), // pages/{n}.png
  thumb: z.string(),
  widthPx: z.number(),
  heightPx: z.number(),
  text: z.string(),
  textSource: z.enum(["text_layer", "ocr", "html", "none"]),
  items: z.array(TextItemSchema),
  languages: z.array(z.enum(["en", "ar"])),
  labels: z.array(PageLabelSchema),
  labelConfidence: z.number(),
  labelReason: z.string(),
  caption: z.string().optional(),
  stats: z
    .object({ whiteRatio: z.number(), saturation: z.number(), edgeDensity: z.number(), colorStd: z.number() })
    .optional(),
});
export type PageRecord = z.infer<typeof PageRecordSchema>;

/** Where a source came from when the app found it itself (a floor plan searched for online). */
export const SourceOriginSchema = z.object({
  kind: z.literal("web-search"),
  foundBy: z.string(), // "Claude Code web search" | "automatic web search"
  queries: z.array(z.string()),
  pageUrl: z.string(), // the page or file the search returned
  planFor: z.string(), // unit type / building the plan belongs to, as its source names it
  match: z.enum(["exact", "same_type", "unverified"]),
  evidence: z.string(),
});
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

export const SourceRecordSchema = z.object({
  id: z.string(), // sha256 prefix
  kind: z.enum(["pdf", "url", "image", "demo"]),
  name: z.string(),
  path: z.string().optional(), // job-relative path of the preserved original
  url: z.string().optional(),
  bytes: z.number().optional(),
  sha256: z.string(),
  pageCount: z.number().optional(),
  meta: z.record(z.string(), z.string()).optional(),
  status: z.enum(["ok", "blocked", "error"]).default("ok"),
  error: z.string().optional(),
  origin: SourceOriginSchema.optional(),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

/** The search for floor plans online, run when no source contains a plan. */
export const PlanSearchSchema = z.object({
  at: z.string(),
  status: z.enum(["waiting", "found", "none", "failed"]),
  foundBy: z.string(),
  queries: z.array(z.string()),
  identified: z.string().optional(),
  candidates: z.array(z.object({
    url: z.string(),
    title: z.string(),
    planFor: z.string(),
    levels: z.array(z.string()).default([]),
    match: z.enum(["exact", "same_type", "different", "unverified"]),
    evidence: z.string(),
    used: z.boolean(),
    error: z.string().optional(),
  })),
  notes: z.string().optional(),
});
export type PlanSearch = z.infer<typeof PlanSearchSchema>;

export const STAGES = ["create", "ingest", "classify", "extract", "review", "reconstruct", "export"] as const;
export type StageName = (typeof STAGES)[number];

export const StageStateSchema = z.object({
  name: z.enum(STAGES),
  status: z.enum(["pending", "running", "done", "error", "waiting"]),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});
export type StageState = z.infer<typeof StageStateSchema>;

export const LogEntrySchema = z.object({
  t: z.string(),
  stage: z.string(),
  level: z.enum(["info", "warn", "error", "fact"]),
  msg: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const JobSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string(),
  status: z.enum(["queued", "running", "review", "ready", "error"]),
  unitFocus: z.string().optional(),
  notes: z.string().optional(),
  extractor: z.enum(["local", "claude", "openai", "claude-code"]),
  extractorLabel: z.string().optional(),
  stages: z.array(StageStateSchema),
  sources: z.array(SourceRecordSchema),
  pages: z.array(PageRecordSchema),
  demo: z.boolean().optional(),
  planSearch: PlanSearchSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;

// ───────────────────────── scene graph (builder output) ─────────────────────────

export type BoxShape = {
  type: "box"; center: Vec3; size: Vec3; rotY: number;
  /** chamfer on every edge, metres (soft furniture) */
  bevel?: number;
  /** tilt about the box's own x axis, radians, applied before rotY (ramps, stair soffits, balustrades) */
  pitch?: number;
};
export type PolyShape = { type: "poly"; polygon: Vec2[]; y: number; thickness: number; holes?: Vec2[][] };
export type ElementKind =
  | "wall" | "lintel" | "sill" | "glass" | "door_leaf" | "frame" | "floor" | "ceiling"
  | "railing" | "handrail" | "furniture" | "slab"
  // extension: structure and site the builder adds around what the plans draw
  | "roof" | "fascia" | "screen" | "stair" | "pool" | "site" | "planting" | "vehicle" | "light" | "curtain";

export type ScenePiece = {
  id: string;
  elementId: string; // wall / opening / room / furniture id in the dossier
  elementKind: ElementKind;
  levelId: string;
  materialId: string;
  inferred: boolean;
  shape: BoxShape | PolyShape;
};

export type SceneMaterial = {
  id: string;
  name: string;
  color: string; // resolved hex
  roughness: number;
  metalness: number;
  opacity: number;
  textureAssetPath?: string;
  inferred: boolean;
  /** light fittings glow */
  emissive?: string;
  emissiveIntensity?: number;
};

export type SceneRoom = {
  id: string;
  name: string;
  program: string;
  levelId: string;
  centroid: Vec3;
  labelPos: Vec3;
  areaM2: number; // what the UI shows: documented when present, else computed
  computedAreaM2: number;
  printedDims?: string;
  documentedAreaM2?: number;
  ceilingHeightM: number;
  ceilingInferred: boolean;
  inferred: boolean;
  floorMaterialId: string;
  polygon: Vec2[]; // plan-space outline (mini-map, walk room detection)
};

export type SceneCollider = { levelId: string; a: Vec2; b: Vec2; halfThickness: number };

export type PropertySceneGraph = {
  version: 1;
  jobId: string;
  dossierHash: string;
  demo: boolean;
  unitTypeId?: string;
  title: string;
  disclaimer: string;
  northDeg?: number;
  levels: Array<{ id: string; name: string; elevationM: number; heightM: number }>;
  materials: SceneMaterial[];
  pieces: ScenePiece[];
  rooms: SceneRoom[];
  colliders: SceneCollider[];
  bounds: { min: Vec3; max: Vec3 };
  spawn: { levelId: string; position: Vec3; yawDeg: number };
  stats: { walls: number; openings: number; rooms: number; inferredPieces: number; attestedPieces: number };
  warnings: string[];
};

// ───────────────────────── helpers ─────────────────────────

export const INFERRED_PREFIX = "inferred:";

/** An element is inferred when none of its evidence comes from a source document or the user. */
export function isInferred(evidence: Evidence[]): boolean {
  return evidence.length === 0 || evidence.every((e) => e.ref.startsWith(INFERRED_PREFIX));
}

export function inferredEvidence(reason: string, confidence = 0.2): Evidence {
  return { source: "user", ref: `${INFERRED_PREFIX}${reason}`, confidence };
}

export function emptyDossier(jobId: string): PropertyDossier {
  return {
    jobId,
    copy: [],
    facts: [],
    unitTypes: [],
    levels: [],
    materials: [],
    assets: [],
    warnings: [],
    completeness: { hasPlan: false, hasScale: false, hasDimensions: false, hasCgi: false, hasFinishSchedule: false },
  };
}
