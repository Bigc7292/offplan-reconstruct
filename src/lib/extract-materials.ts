// Stage 3C: photometric / style pass over CGI and photos.
// Claude path: materials + lighting mood per render. Local path: floor and wall tones are
// sampled from each interior render and bound to the room program named in its caption.
// Stone/wood names are only used when written in a caption or finish schedule.
import type { Evidence, Material, PageRecord, Surface } from "./schema";
import type { AssetIndexEntry } from "./ingest";
import { callStructured, CGI_SYSTEM, CgiSchema } from "./llm";
import { jobFile, log } from "./store";
import { regionColor } from "./image-stats";
import { programFor } from "./extract-plan";
import sharp from "sharp";

type LabelledAsset = AssetIndexEntry & { kind: string; caption?: string };

const NAMED_FINISH = /\b(calacatta|statuario|carrara|marble|travertine|limestone|onyx|terrazzo|porcelain|oak|walnut|teak|ash|herringbone|parquet|brass|bronze|champagne|chrome|stainless|quartz|granite|microcement|veneer|lacquer)\b/i;

export async function extractMaterials(
  jobId: string, pages: PageRecord[], assets: LabelledAsset[], useClaude: boolean,
): Promise<{ materials: Material[]; warnings: string[]; facts: Array<{ key: string; value: string; evidence: Evidence[] }> }> {
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

  for (const a of cgi.slice(0, useClaude ? 16 : 60)) {
    const page = pages.find((p) => p.n === a.page);
    const caption = a.caption ?? page?.caption;
    const program = caption ? programFor(caption.replace(/^.*?[–-]\s*/, "")) : a.kind === "cgi_exterior" ? "exterior" : "other";
    const file = jobFile(jobId, a.path);
    const lum = (await sharp(file).greyscale().stats()).channels[0].mean;
    if (lum < 85) nightCount++; else dayCount++;
    if (a.kind === "cgi_exterior") continue;

    if (useClaude) {
      try {
        const out = await callStructured(jobId, { task: `materials ${a.id}`, system: CGI_SYSTEM, schema: CgiSchema, schemaName: "Material[]", prompt: `Render from page ${a.page}. Caption: ${caption ?? "(none)"}.`, images: [file] });
        out.materials.forEach((m, i) => {
          const mat: Material = {
            id: `m-${a.id}-${i + 1}`, name: m.nameIsWrittenOrObvious ? m.name : `${m.name} (as seen in render)`, albedoHint: m.albedoHex, roughness: m.roughness, metalness: m.metalness,
            mapsFromAssetIds: [a.id], appliedTo: m.appliedTo, programs: out.program !== "other" ? [out.program] : undefined,
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
  return { materials, warnings, facts };
}

/** First render per room program wins; later renders of the same room are kept as references, never averaged. */
function addBound(byProgram: Map<string, Material[]>, out: Material[], m: Material) {
  const key = `${m.programs?.join(",") ?? "*"}|${m.appliedTo.join(",")}`;
  const existing = byProgram.get(key);
  if (existing?.length) {
    existing[0].mapsFromAssetIds = [...new Set([...existing[0].mapsFromAssetIds, ...m.mapsFromAssetIds])];
    existing[0].evidence.push(...m.evidence.map((e) => ({ ...e, confidence: Math.min(e.confidence, 0.3) })));
    return;
  }
  byProgram.set(key, [m]);
  out.push(m);
}
