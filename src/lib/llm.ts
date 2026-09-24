// Multimodal model calls. Structured outputs only: every call passes a Zod schema and
// the reply is parsed against it (free-form replies are rejected). Every call is logged
// to the job's model-calls.jsonl with prompt, schema, and token usage.
//
// Providers (first match wins):
//   LLM_PROVIDER=openai + LLM_BASE_URL + LLM_API_KEY + LLM_MODEL → any OpenAI-compatible
//     gateway. LLM_API=chat (default) uses /v1/chat/completions, LLM_API=responses uses
//     /v1/responses (some models, e.g. gpt-6-astra on OneProvider, only answer there).
//   ANTHROPIC_API_KEY → Claude via the Anthropic SDK
//   neither → the local extractor runs and no model is called.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import sharp from "sharp";
import { logModelCall } from "./store";

export type ExtractorKind = "claude" | "openai" | "local";

const OPENAI = {
  baseUrl: (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "").replace(/\/v1$/, ""),
  key: process.env.LLM_API_KEY ?? "",
  model: process.env.LLM_MODEL ?? "",
  api: process.env.LLM_API === "responses" ? "responses" : "chat",
  effort: process.env.LLM_REASONING_EFFORT || undefined,
};

export function extractorKind(): ExtractorKind {
  if (process.env.LLM_PROVIDER === "openai" && OPENAI.baseUrl && OPENAI.key && OPENAI.model) return "openai";
  return process.env.ANTHROPIC_API_KEY ? "claude" : "local";
}

export const MODEL = extractorKind() === "openai" ? OPENAI.model : process.env.ANTHROPIC_MODEL || "claude-opus-5";

/** Human label for the UI, e.g. "gpt-6-astra via api.example.dev". */
export function extractorLabel(): string {
  const k = extractorKind();
  if (k === "openai") return `${OPENAI.model} via ${new URL(OPENAI.baseUrl).hostname}`;
  if (k === "claude") return `Claude (${MODEL})`;
  return "local (no model)";
}

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

async function imagePng(file: string) {
  // Vision input is capped at ~1568 px on the long edge; downscale here so tiny plan text keeps its detail budget.
  return sharp(file).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
}

type CallOpts<S> = { task: string; system: string; prompt: string; images?: string[]; schema: S; schemaName: string };

export async function callStructured<S extends z.ZodType>(jobId: string, opts: CallOpts<S>): Promise<z.infer<S>> {
  const started = Date.now();
  try {
    const kind = extractorKind();
    const { parsed, usage, stop } = kind === "openai" ? (OPENAI.api === "responses" ? await callResponses(opts) : await callOpenAI(opts)) : await callClaude(opts);
    await logModelCall(jobId, {
      task: opts.task, model: MODEL, schema: opts.schemaName, system: opts.system, prompt: opts.prompt,
      images: opts.images, usage, stop_reason: stop, ms: Date.now() - started,
    });
    return parsed;
  } catch (e) {
    await logModelCall(jobId, { task: opts.task, model: MODEL, schema: opts.schemaName, prompt: opts.prompt, images: opts.images, error: String(e), ms: Date.now() - started });
    throw e;
  }
}

async function callClaude<S extends z.ZodType>(opts: CallOpts<S>) {
  const images = await Promise.all((opts.images ?? []).map(imagePng));
  const content = [
    ...images.map((b) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: b.toString("base64") } })),
    { type: "text" as const, text: opts.prompt },
  ];
  const res = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: opts.system,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(opts.schema) },
  });
  if (res.stop_reason === "refusal") throw new Error(`Model declined the ${opts.task} request.`);
  if (res.stop_reason === "max_tokens") throw new Error(`Model output for ${opts.task} was cut off (max_tokens).`);
  if (!res.parsed_output) throw new Error(`Model reply for ${opts.task} did not match schema ${opts.schemaName}.`);
  return { parsed: res.parsed_output as z.infer<S>, usage: res.usage, stop: res.stop_reason };
}

/** OpenAI-compatible chat completions with a JSON-schema response format, validated with Zod. */
async function callOpenAI<S extends z.ZodType>(opts: CallOpts<S>) {
  const images = await Promise.all((opts.images ?? []).map(imagePng));
  const jsonSchema = z.toJSONSchema(opts.schema);
  const user = [
    ...images.map((b) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b.toString("base64")}` } })),
    { type: "text", text: opts.prompt },
  ];
  const body = (format: "json_schema" | "json_object") => ({
    model: OPENAI.model,
    max_tokens: 16000,
    messages: [
      { role: "system", content: format === "json_schema" ? opts.system : `${opts.system}\n\nReply with one JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(jsonSchema)}` },
      { role: "user", content: user },
    ],
    response_format: format === "json_schema"
      ? { type: "json_schema", json_schema: { name: opts.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_"), schema: jsonSchema, strict: false } }
      : { type: "json_object" },
  });
  const post = async (format: "json_schema" | "json_object") => {
    const res = await fetch(`${OPENAI.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI.key}` },
      body: JSON.stringify(body(format)),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
  let r = await post("json_schema");
  // some gateways/models reject json_schema; fall back to JSON mode with the schema in the prompt
  if (r.status === 400 && /response_format|json_schema/i.test(r.text)) r = await post("json_object");
  if (r.status < 200 || r.status >= 300) throw new Error(`Model gateway returned ${r.status} for ${opts.task}: ${r.text.slice(0, 300)}`);
  const data = JSON.parse(r.text);
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error(`Model output for ${opts.task} was cut off (max_tokens).`);
  if (choice?.message?.refusal) throw new Error(`Model declined the ${opts.task} request.`);
  const raw = String(choice?.message?.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error(`Model reply for ${opts.task} was not JSON.`); }
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) throw new Error(`Model reply for ${opts.task} did not match schema ${opts.schemaName}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return { parsed: parsed.data as z.infer<S>, usage: data.usage, stop: choice?.finish_reason };
}

/**
 * OpenAI Responses API (/v1/responses), validated with Zod. Streams, because OneProvider drops
 * non-streamed requests that run past ~30 s with a 502. The gateway also ignores text.format,
 * so the JSON Schema is repeated in the prompt.
 */
async function callResponses<S extends z.ZodType>(opts: CallOpts<S>) {
  const images = await Promise.all((opts.images ?? []).map(imagePng));
  const jsonSchema = z.toJSONSchema(opts.schema);
  const body = (effort: string | undefined) => JSON.stringify({
    model: OPENAI.model,
    max_output_tokens: 32000,
    stream: true,
    ...(effort ? { reasoning: { effort } } : {}),
    instructions: opts.system,
    input: [{
      role: "user",
      content: [
        ...images.map((b) => ({ type: "input_image", image_url: `data:image/png;base64,${b.toString("base64")}`, detail: "high" })),
        { type: "input_text", text: `${opts.prompt}\n\nReply with one JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(jsonSchema)}` },
      ],
    }],
    text: { format: { type: "json_schema", name: opts.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_"), schema: jsonSchema, strict: false } },
  });
  let final: { status?: string; usage?: unknown; incomplete_details?: { reason?: string }; output?: { type: string; content?: { type: string; text?: string }[] }[] } | undefined;
  let lastErr = "";
  for (let attempt = 1; attempt <= 5 && !final; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (attempt - 2), 10_000)));
    try {
      const res = await fetch(`${OPENAI.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI.key}` },
        // the gateway gives up if the first byte takes >30 s; long-reasoning plan calls hit that, so retries reason less
        body: body(attempt === 1 ? OPENAI.effort : "low"),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = `Model gateway returned ${res.status} for ${opts.task}: ${text.slice(0, 300)}`;
        if (res.status >= 500 || res.status === 429) continue;
        throw new Error(lastErr);
      }
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === "response.completed" || ev.type === "response.incomplete") final = ev.response;
        else if (ev.type === "response.failed" || ev.type === "error") lastErr = `Model gateway failed ${opts.task}: ${JSON.stringify(ev.response?.error ?? ev.error ?? ev).slice(0, 300)}`;
      }
    } catch (e) {
      if (String(e).includes("Model gateway returned 4")) throw e;
      lastErr = `Model gateway call for ${opts.task} failed: ${(e as Error).cause ?? e}`;
    }
  }
  if (!final) throw new Error(lastErr || `Model gateway returned no response for ${opts.task}.`);
  if (final.status === "incomplete") throw new Error(`Model output for ${opts.task} was cut off (${final.incomplete_details?.reason ?? "incomplete"}).`);
  const parts = (final.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  if (parts.some((c) => c.type === "refusal")) throw new Error(`Model declined the ${opts.task} request.`);
  const raw = parts.map((c) => c.text ?? "").join("").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error(`Model reply for ${opts.task} was not JSON: ${raw.slice(0, 200)}`); }
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) throw new Error(`Model reply for ${opts.task} did not match schema ${opts.schemaName}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return { parsed: parsed.data as z.infer<S>, usage: final.usage, stop: final.status };
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
