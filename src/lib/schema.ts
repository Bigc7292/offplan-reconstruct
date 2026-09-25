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

export const FurnitureSchema = z.object({
  // extension: FF&E proxy, only emitted when the brochure shows a furniture layout
  id: z.string(),
  kind: z.enum(["bed_double", "bed_single", "sofa", "dining", "kitchen_run", "island", "wardrobe", "bath", "wc", "vanity", "desk", "armchair", "other"]),
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
});
export type Level = z.infer<typeof LevelSchema>;

export const SurfaceSchema = z.enum(["floor", "wall", "ceiling", "joinery", "counter", "facade", "glass"]);
export type Surface = z.infer<typeof SurfaceSchema>;

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
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

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
});
export type Job = z.infer<typeof JobSchema>;

// ───────────────────────── scene graph (builder output) ─────────────────────────

export type BoxShape = { type: "box"; center: Vec3; size: Vec3; rotY: number; /** chamfer on every edge, metres (soft furniture) */ bevel?: number };
export type PolyShape = { type: "poly"; polygon: Vec2[]; y: number; thickness: number };
export type ElementKind =
  | "wall" | "lintel" | "sill" | "glass" | "door_leaf" | "frame" | "floor" | "ceiling"
  | "railing" | "handrail" | "furniture" | "slab";

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
