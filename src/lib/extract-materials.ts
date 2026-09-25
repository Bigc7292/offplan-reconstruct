// Stage 3C: photometric / style pass over CGI and photos.
// Claude path: materials + lighting mood per render. Local path: floor and wall tones are
// sampled from each interior render and bound to the room program named in its caption.
// Stone/wood names are only used when written in a caption or finish schedule.
import type { Evidence, Exterior, Material, PageRecord, Surface } from "./schema";
import type { AssetIndexEntry } from "./ingest";
import { callStructured, CGI_SYSTEM, CgiSchema } from "./llm";
import { jobFile, log } from "./store";
import { regionColor } from "./image-stats";
import { programFor } from "./extract-plan";
import { floorOf } from "./materials";
import sharp from "sharp";
import type * as z from "zod/v4";

type LabelledAsset = AssetIndexEntry & { kind: string; caption?: string };

const NAMED_FINISH = /\b(calacatta|statuario|carrara|marble|travertine|limestone|onyx|terrazzo|porcelain|oak|walnut|teak|ash|herringbone|parquet|brass|bronze|champagne|chrome|stainless|quartz|granite|microcement|veneer|lacquer)\b/i;

export async function extractMaterials(
  jobId: string, pages: PageRecord[], assets: LabelledAsset[], useClaude: boolean,
): Promise<{ materials: Material[]; warnings: string[]; facts: Array<{ key: string; value: string; evidence: Evidence[] }>; exterior?: Exterior }> {
  let exterior: Exterior | undefined;
  const materials: Material[] = [];
  const warnings: string[] = [];
  const facts: Array<{ key: string; value: string; evidence: Evidence[] }> = [];
  const cgi = assets.filter((a) => a.kind === "cgi_interior" || a.kind === "cgi_exterior");
  const byProgram = new Map<string, Material[]>();
  let nightCount = 0, dayCount = 0;

  // named finishes written anywhere in the text become finish-schedule materials
  for (const p of pages) {
    for (const line of p.text.split("\n")) {
      const m = line.match(NAMED_FINISH);
      if (!m || line.length > 120) continue;
      const surface: Surface[] = /floor/i.test(line) ? ["floor"] : /counter|worktop/i.test(line) ? ["counter"] : /joinery|cabinet|door|wardrobe/i.test(line) ? ["joinery"] : /wall/i.test(line) ? ["wall"] : /brass|bronze|chrome|champagne|stainless/i.test(m[1]) ? ["joinery"] : ["floor"];
      const id = `m-text-${materials.length + 1}`;
      materials.push({
        id, name: line.trim(), albedoHint: m[1], roughness: /marble|chrome|brass|quartz/i.test(m[1]) ? 0.3 : 0.6, metalness: /brass|bronze|chrome|champagne|stainless/i.test(m[1]) ? 0.9 : 0,
        mapsFromAssetIds: [], appliedTo: surface,
        evidence: [{ source: "pdf", ref: `page-${p.n}`, quote: line.trim(), confidence: 0.75 }],
      });
    }
  }

  const batch = cgi.slice(0, useClaude ? 16 : 60);
  // vision calls are slow (tens of seconds each through a gateway), so run up to 4 at once
  const vision = new Map<string, Promise<{ ok: true; out: z.infer<typeof CgiSchema> } | { ok: false; error: unknown }>>();
  if (useClaude) {
    // every interior render, and the first two exterior renders (for the facade, slab edges, paving and pool)
    const todo = [...batch.filter((a) => a.kind !== "cgi_exterior"), ...batch.filter((a) => a.kind === "cgi_exterior").slice(0, 2)];
    const slots: Promise<unknown>[] = [];
    for (const a of todo) {
      if (slots.length >= 4) await Promise.race(slots);
      const pageCaption = a.caption ?? pages.find((p) => p.n === a.page)?.caption;
      const job = callStructured(jobId, { task: `materials ${a.id}`, system: CGI_SYSTEM, schema: CgiSchema, schemaName: "Material[]", prompt: `Render from page ${a.page}. Caption: ${pageCaption ?? "(none)"}.`, images: [jobFile(jobId, a.path)] })
        .then((out) => ({ ok: true as const, out }), (error) => ({ ok: false as const, error }));
      vision.set(a.id, job);
      const slot: Promise<unknown> = job.finally(() => slots.splice(slots.indexOf(slot), 1));
      slots.push(slot);
    }
  }

  for (const a of batch) {
    const page = pages.find((p) => p.n === a.page);
    const caption = a.caption ?? page?.caption;
    const program = caption ? programFor(caption.replace(/^.*?[–-]\s*/, "")) : a.kind === "cgi_exterior" ? "exterior" : "other";
    const file = jobFile(jobId, a.path);
    const lum = (await sharp(file).greyscale().stats()).channels[0].mean;
    if (lum < 85) nightCount++; else dayCount++;
    if (a.kind === "cgi_exterior") {
      // exterior renders give the facade, slab edges, frames, paving, lawn and pool their finishes (by role)
      const r = useClaude ? await vision.get(a.id) : undefined;
      if (r?.ok) {
        // the first exterior render that describes the massing (slab edges, overhangs, screens, pergola) sets it
        if (!exterior && r.out.exterior) exterior = { ...r.out.exterior, evidence: [{ source: "image", ref: a.id, quote: r.out.caption ?? caption ?? `render on page ${a.page}`, confidence: 0.5 }] };
        const gain = whiteBalance(r.out.materials);
        r.out.materials.forEach((m, i) => {
          const role = roleFor(m.name, m.appliedTo);
          if (!role || materials.some((x) => x.role === role)) return;
          materials.push({
            id: `m-${a.id}-x${i + 1}`, name: m.nameIsWrittenOrObvious ? m.name : `${m.name} (as seen in render)`, albedoHint: balance(m.albedoHex, gain), roughness: m.roughness, metalness: m.metalness,
            mapsFromAssetIds: [a.id], appliedTo: role === "facade_wall" ? ["facade"] : [], programs: ["exterior"], role,
            evidence: [{ source: "image", ref: a.id, quote: [r.out.caption ?? caption, r.out.lightingMood].filter(Boolean).join(" · "), bbox: m.regionBbox as [number, number, number, number], confidence: 0.45 }],
          });
        });
      }
      continue;
    }

    if (useClaude) {
      try {
        const r = await vision.get(a.id)!;
        if (!r.ok) throw r.error;
        const out = r.out;
        // renders are lit warm: neutralise the colour cast using a white ceiling seen in the same render
        const gain = whiteBalance(out.materials);
        out.materials.forEach((m, i) => {
          const mat: Material = {
            id: `m-${a.id}-${i + 1}`, name: m.nameIsWrittenOrObvious ? m.name : `${m.name} (as seen in render)`, albedoHint: balance(m.albedoHex, gain), roughness: m.roughness, metalness: m.metalness,
            // always bound to the render's room program: a garage or plant-room render ("other") must not
            // set the finish of every room in the house
            mapsFromAssetIds: [a.id], appliedTo: m.appliedTo, programs: [out.program],
            evidence: [{ source: "image", ref: a.id, quote: [out.caption ?? caption, out.lightingMood].filter(Boolean).join(" · "), bbox: m.regionBbox as [number, number, number, number], confidence: m.nameIsWrittenOrObvious ? 0.7 : 0.45 }],
          };
          addBound(byProgram, materials, mat);
        });
        continue;
      } catch (e) {
        warnings.push(`Render ${a.id}: vision material pass failed (${e instanceof Error ? e.message : e}); sampled tones instead.`);
      }
    }
    if (program === "other" || program === "exterior") continue;
    // local: floor = lower-centre band, wall = upper-middle band of the render
    const floorHex = await regionColor(file, { x0: 0.3, y0: 0.86, x1: 0.7, y1: 0.98 });
    const wallHex = await regionColor(file, { x0: 0.05, y0: 0.25, x1: 0.25, y1: 0.55 });
    const q = caption ?? `render on page ${a.page}`;
    for (const [surface, hex, box] of [["floor", floorHex, [0.3, 0.86, 0.7, 0.98]], ["wall", wallHex, [0.05, 0.25, 0.25, 0.55]]] as const) {
      addBound(byProgram, materials, {
        id: `m-${a.id}-${surface}`,
        name: `${surface === "floor" ? "Floor" : "Wall"} tone sampled from render: ${q}`,
        albedoHint: hex, roughness: surface === "floor" ? 0.45 : 0.85, metalness: 0,
        mapsFromAssetIds: [a.id], appliedTo: [surface], programs: [program],
        evidence: [{ source: "image", ref: a.id, quote: q, bbox: [...box], confidence: 0.35 }],
      });
    }
  }
  if (nightCount + dayCount) {
    const mood = nightCount > dayCount ? "dusk" : "day";
    facts.push({ key: "lighting.mood", value: mood, evidence: [{ source: "image", ref: "cgi-set", quote: `${dayCount} day / ${nightCount} night render(s)`, confidence: 0.6 }] });
  }
  if (!cgi.length) warnings.push("No CGI or photos found; finishes use neutral defaults (marked inferred).");
  await log(jobId, "extract", `Material pass: ${materials.length} material(s) from ${cgi.length} render(s)/photo(s).`);
  return { materials, warnings, facts, exterior };
}

/** First render per room program wins; later renders of the same room are kept as references, never averaged. */
function addBound(byProgram: Map<string, Material[]>, out: Material[], m: Material) {
  // renders of the same kind of room on different floors (a ground-floor and a first-floor lounge) stay separate
  const key = `${m.programs?.join(",") ?? "*"}|${m.appliedTo.join(",")}|${floorOf(m.evidence[0]?.quote) ?? ""}`;
  const existing = byProgram.get(key);
  if (existing?.length) {
    existing[0].mapsFromAssetIds = [...new Set([...existing[0].mapsFromAssetIds, ...m.mapsFromAssetIds])];
    existing[0].evidence.push(...m.evidence.map((e) => ({ ...e, confidence: Math.min(e.confidence, 0.3) })));
    return;
  }
  byProgram.set(key, [m]);
  out.push(m);
}

type Gain = [number, number, number];
const rgb = (hex: string): Gain | null => (/^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as Gain : null);

/**
 * Per-channel gains that turn a white surface in the render (a painted ceiling, white plaster) into a neutral
 * light grey, so finishes are not read in the render's warm light. No white reference, no correction.
 */
function whiteBalance(ms: Array<{ name: string; albedoHex: string; appliedTo: string[] }>): Gain {
  const ref = ms.find((m) => m.appliedTo.includes("ceiling") && /white|paint|plaster/i.test(m.name) && !/black|dark|timber|wood|slat/i.test(m.name))
    ?? ms.find((m) => /\bwhite\b/i.test(m.name) && !/marble|vein/i.test(m.name));
  const c = ref ? rgb(ref.albedoHex) : null;
  if (!c || Math.min(...c) < 60) return [1, 1, 1];
  return c.map((v) => Math.max(0.85, Math.min(1.6, 236 / v))) as Gain;
}

function balance(hex: string, g: Gain): string {
  const c = rgb(hex);
  if (!c || (g[0] === 1 && g[1] === 1 && g[2] === 1)) return hex;
  return "#" + c.map((v, k) => Math.round(Math.min(255, v * g[k])).toString(16).padStart(2, "0")).join("");
}

/** What an exterior finish is for, from how the render reader named it. */
function roleFor(name: string, appliedTo: string[]): Material["role"] | undefined {
  const n = name.toLowerCase();
  if (/pool|water/.test(n) && !/coping|edge|tile surround/.test(n)) return "pool_water";
  if (/coping/.test(n)) return "pool_coping";
  if (/lawn|grass|turf/.test(n)) return "lawn";
  if (/pergola/.test(n)) return "pergola";
  if (/slat|louvre|louver|fin\b|screen/.test(n)) return "screen";
  if (/frame|mullion|aluminium|aluminum/.test(n)) return "window_frame";
  if (/balustrade|railing/.test(n)) return "balustrade";
  if (/slab edge|fascia|soffit|band/.test(n)) return /soffit/.test(n) ? "soffit" : "slab_edge";
  if (/boundary|compound wall/.test(n)) return "boundary_wall";
  if (/gate/.test(n)) return "gate";
  if (/driveway|asphalt/.test(n)) return "driveway";
  if (/paving|pavers|deck|terrace floor|stone floor|tiles?\b/.test(n) || (appliedTo.includes("floor") && !/indoor|interior/.test(n))) return "paving";
  if (/roof/.test(n)) return "roof";
  if (/facade|façade|render|plaster|cladding|wall/.test(n) || appliedTo.includes("facade") || appliedTo.includes("wall")) return "facade_wall";
  return undefined;
}
