// Claude multimodal calls. Structured outputs only: every call passes a Zod schema and
// the reply is parsed against it (free-form replies are rejected). Every call is logged
// to the job's model-calls.jsonl with prompt, schema, and token usage.
//
// Active only when ANTHROPIC_API_KEY is set; otherwise the local extractor runs.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import sharp from "sharp";
import { logModelCall } from "./store";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

export function extractorKind(): "claude" | "local" {
  return process.env.ANTHROPIC_API_KEY ? "claude" : "local";
}

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

async function imageBlock(file: string) {
  // Vision input is capped at ~1568 px on the long edge; downscale here so tiny plan text keeps its detail budget.
  const buf = await sharp(file).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: buf.toString("base64") } };
}

export async function callStructured<S extends z.ZodType>(
  jobId: string,
  opts: { task: string; system: string; prompt: string; images?: string[]; schema: S; schemaName: string },
): Promise<z.infer<S>> {
  const started = Date.now();
  const content = [...(await Promise.all((opts.images ?? []).map(imageBlock))), { type: "text" as const, text: opts.prompt }];
  try {
    const res = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: opts.system,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(opts.schema) },
    });
    await logModelCall(jobId, {
      task: opts.task, model: MODEL, schema: opts.schemaName, system: opts.system, prompt: opts.prompt,
      images: opts.images, usage: res.usage, stop_reason: res.stop_reason, ms: Date.now() - started,
    });
    if (res.stop_reason === "refusal") throw new Error(`Model declined the ${opts.task} request.`);
    if (res.stop_reason === "max_tokens") throw new Error(`Model output for ${opts.task} was cut off (max_tokens).`);
    if (!res.parsed_output) throw new Error(`Model reply for ${opts.task} did not match schema ${opts.schemaName}.`);
    return res.parsed_output as z.infer<S>;
  } catch (e) {
    await logModelCall(jobId, { task: opts.task, model: MODEL, schema: opts.schemaName, prompt: opts.prompt, images: opts.images, error: String(e), ms: Date.now() - started });
    throw e;
  }
}

// ───────────────────────── prompts & schemas used by the extract-* modules ─────────────────────────

export const PLAN_SYSTEM = `You are an architectural draughtsman converting a sales floor plan into machine geometry.

Return ONLY JSON matching the schema.

Rules:
- Units in meters.
- Origin at the bottom-left of the drawn plan bounding box.
- Preserve printed dimensions exactly. If a wall is labeled 3850, it is 3.85 m.
- Room names must be the labels on the drawing, not synonyms.
- Balconies, terraces, maid rooms, powder rooms, utility, and shafts are first-class rooms.
- If scale cannot be proven from a dimension or scale bar, set scaleConfidence < 0.4 and still return pixel-space geometry plus the raw dimension strings you saw.
- Never invent a room that is not outlined.
- List every dimension string you read in evidence[].quote.`;

const PlanEvidence = z.object({ quote: z.string(), bbox: z.array(z.number()).length(4).describe("image-normalised 0-1 [x0,y0,x1,y1]"), confidence: z.number() });
const P2 = z.object({ x: z.number(), y: z.number() });
export const PlanLevelSchema = z.object({
  levelName: z.string().describe("level name exactly as printed, e.g. 'FIRST FLOOR'"),
  units: z.enum(["meters", "pixels"]).describe("meters when scale is proven, else pixels of the supplied image"),
  scaleConfidence: z.number().min(0).max(1),
  scaleSource: z.string().describe("which dimension string or scale bar proved the scale, or 'none'"),
  pxPerMeter: z.number().nullable().describe("image pixels per metre if known"),
  planBoundsPx: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).describe("pixel bbox of the drawn plan in the supplied image"),
  northArrowDeg: z.number().nullable().describe("degrees clockwise from image-up that the north arrow points, null if no arrow"),
  rooms: z.array(z.object({
    name: z.string(),
    program: z.enum(["bedroom", "living", "kitchen", "bath", "balcony", "circulation", "storage", "amenity", "other"]),
    polygon: z.array(P2),
    printedDimensions: z.string().nullable().describe("e.g. '4.2 X 2.4' exactly as printed"),
    printedAreaM2: z.number().nullable(),
    evidence: z.array(PlanEvidence),
  })),
  walls: z.array(z.object({
    a: P2, b: P2, thickness: z.number(),
    kind: z.enum(["exterior", "interior", "railing", "glass", "partition"]),
    openings: z.array(z.object({ kind: z.enum(["door", "sliding_door", "window", "opening"]), offset: z.number().describe("0-1 along a→b, centre"), width: z.number() })),
  })),
  furniture: z.array(z.object({ kind: z.enum(["bed_double", "bed_single", "sofa", "dining", "kitchen_run", "island", "wardrobe", "bath", "wc", "vanity", "desk", "armchair", "other"]), center: P2, w: z.number(), d: z.number(), rotationDeg: z.number() })),
  dimensionStrings: z.array(z.string()),
});
export type PlanLevelOut = z.infer<typeof PlanLevelSchema>;

export const CGI_SYSTEM = `Identify materials, colors, fixtures, and likely room.
Return Material[] plus a short lighting mood.
Quote any visible caption. Do not guess stone names that are not written or obvious.`;

export const CgiSchema = z.object({
  caption: z.string().nullable(),
  likelyRoom: z.string(),
  program: z.enum(["bedroom", "living", "kitchen", "bath", "balcony", "circulation", "storage", "amenity", "exterior", "other"]),
  interior: z.boolean(),
  lightingMood: z.string(),
  timeOfDay: z.enum(["day", "dusk", "night", "unknown"]),
  materials: z.array(z.object({
    name: z.string().describe("as specific as the image or caption proves; generic otherwise ('light stone', 'warm wood')"),
    albedoHex: z.string().describe("#rrggbb sampled from the image"),
    roughness: z.number(), metalness: z.number(),
    appliedTo: z.array(z.enum(["floor", "wall", "ceiling", "joinery", "counter", "facade", "glass"])),
    regionBbox: z.array(z.number()).length(4).describe("image-normalised 0-1 region where the material is visible"),
    nameIsWrittenOrObvious: z.boolean(),
  })),
});

export const CLASSIFY_SYSTEM = `You classify pages of off-plan real-estate brochures. A page can have several labels.
Labels: cover | masterplan | amenities | typical_floor | unit_plan | furniture_layout | elevation | section | cgi_interior | cgi_exterior | material_board | specs_schedule | legal_disclaimer | location | other.
Quote the caption text you rely on. Return ONLY JSON.`;

export const ClassifySchema = z.object({
  labels: z.array(z.enum(["cover", "masterplan", "amenities", "typical_floor", "unit_plan", "furniture_layout", "elevation", "section", "cgi_interior", "cgi_exterior", "material_board", "specs_schedule", "legal_disclaimer", "location", "other"])),
  confidence: z.number(),
  caption: z.string().nullable(),
  reason: z.string(),
});

export const FACTS_SYSTEM = `You extract facts from the full text of off-plan real-estate brochures and listings.
Return every numeric value (areas, heights, counts, prices, dates), project/developer/location names, unit types and view claims.
Quote the exact source text for each fact and give the page reference supplied with the text. Never convert or round in the quote.
Prices are stored as printed; do not treat them as confirmed. Return ONLY JSON.`;

export const FactsSchema = z.object({
  projectName: z.string().nullable(),
  developer: z.string().nullable(),
  location: z.string().nullable(),
  facts: z.array(z.object({ key: z.string().describe("dotted key, e.g. area.bua_m2, price.asking_aed, handover"), value: z.string(), quote: z.string(), pageRef: z.string() })),
  unitTypes: z.array(z.object({ code: z.string(), beds: z.number().nullable(), baths: z.number().nullable(), suiteAreaM2: z.number().nullable(), balconyAreaM2: z.number().nullable(), totalAreaM2: z.number().nullable(), pageRefs: z.array(z.string()) })),
  disclaimers: z.array(z.string()),
});
