// Stage 2: label every page (multi-label) and every extracted image asset.
// Local classifier = keyword evidence from text/OCR + image signals. Claude classifier when a key is set.
import { limiter, settle, MODEL_CONCURRENCY } from "./concurrency";
import type { AssetKind, PageLabel, PageRecord, SourceRecord } from "./schema";
import { jobFile, log, readJob, updateJob, writeJobFile } from "./store";
import { readAssetIndex, type AssetIndexEntry } from "./ingest";
import { dHash, findDrawingRegion, findPhotoRegion, imageStats, type ImageStats } from "./image-stats";
import sharp from "sharp";
import { callStructured, CLASSIFY_SYSTEM, ClassifySchema, extractorKind } from "./llm";

export const LEVEL_WORDS = /\b(basement|ground\s*floor|groundfloor|first\s*floor|second\s*floor|third\s*floor|mezzanine|podium|roof\s*top|rooftop|roof|typical\s*floor|level\s*\d+|penthouse|upper\s*floor|lower\s*floor)\b/i;
export const ROOM_WORDS = /\b(bed\s*room|bedroom|master|guest|kitchen|living|lounge|dining|majlis|maid|driver|laundry|powder|bath(room)?|toilet|wc|en-?suite|balcony|terrace|pool|store|storage|elevator|lift|lobby|entrance|foyer|family|dress(ing)?|walk-?in|wardrobe|closet|study|office|gym|cinema|bbq|garage|parking|services?|pantry|utility|staff|nanny|vault|bar|showroom|sunken|plunge|garden|deck)\b/gi;
const DIM_RE = /\b\d{1,2}[.,]\d{1,2}\s*[x×X]\s*\d{1,2}[.,]\d{1,2}\b|\b\d{4}\s*[x×X]\s*\d{4}\b/;

type Scores = Partial<Record<PageLabel, number>>;

/** Words that pin a render/photo to an interior room (vs. exterior views). */
const INTERIOR_CAPTION = /\b(bed\s*room|bedroom|living|lounge|dining|kitchen|bath|powder|entrance|foyer|majlis|office|gym|cinema|closet|walk-?in|dressing|vault|showroom|bar|interior)\b/i;
const EXTERIOR_CAPTION = /\b(exterior|facade|façade|aerial|elevation view|street|night view|pool view|garden view|front view|rear view)\b/i;

export function extractCaption(p: PageRecord): string | undefined {
  // "Ground floor – Formal living", "First Floor - Bedroom 3", "Rooftop - Gym"
  const lines = p.text.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const l of lines) {
    const m = l.match(/^((?:ground|first|second|third|basement|roof\s*top|rooftop|mezzanine)\s*(?:floor)?)\s*[-–—:]\s*(.{3,60})$/i);
    if (m) return `${m[1].trim()} – ${m[2].trim()}`;
  }
  return undefined;
}

export function localClassify(p: PageRecord, isFirstPageOfSource: boolean, assetStats: ImageStats[]): { labels: PageLabel[]; confidence: number; reason: string } {
  const t = p.text;
  const s: Scores = {};
  const why: string[] = [];
  const add = (l: PageLabel, v: number, reason: string) => { s[l] = (s[l] ?? 0) + v; why.push(`${l}+${v.toFixed(1)}: ${reason}`); };
  const count = (re: RegExp) => (t.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;

  const levels = count(LEVEL_WORDS);
  const rooms = count(ROOM_WORDS);
  const dims = count(DIM_RE);
  const caption = extractCaption(p);
  const st = p.stats;

  if (isFirstPageOfSource) add("cover", 1.2, "first page of source");
  if (/floor\s*plan|unit\s*plan|layout|key\s*plan|typical\s*floor/i.test(t)) add("unit_plan", 1.5, "plan keyword");
  if (/typical\s*floor|floor\s*plate/i.test(t)) add("typical_floor", 2, "typical floor keyword");
  const photoN = assetStats.filter((x) => x.colorStd > 45 && x.saturation > 0.12 && x.whiteRatio < 0.35).length;
  const drawN = assetStats.filter((x) => x.whiteRatio > 0.25 && x.saturation < 0.12 && x.edgeDensity > 0.04).length;
  // room/level words next to photos are photo captions ("Lounge First Floor"), not a plan schedule
  if (levels >= 1 && rooms >= 4 && !caption && !(photoN >= 2 && photoN > drawN)) add("unit_plan", 1 + Math.min(2, rooms / 6), `${levels} level name(s) and ${rooms} room word(s)`);
  if (dims >= 2) add("unit_plan", 1.5, `${dims} dimension string(s)`);
  if (/furniture|ff&e/i.test(t)) add("furniture_layout", 1.5, "furniture keyword");
  if (/\belevation\b/i.test(t) && !/elevator/i.test(t)) add("elevation", 1.5, "elevation keyword");
  if (/\bsection\b/i.test(t)) add("section", 1, "section keyword");
  if (/master\s*plan|masterplan|community\s*plan|site\s*plan/i.test(t)) add("masterplan", 2, "masterplan keyword");
  if (/amenit|clubhouse|swimming|gym|spa\b|kids|park\b|lagoon|beach/i.test(t)) add("amenities", 1, "amenity words");
  if (/\blocation\b|district|minutes?\s+(to|from)|km\s+(to|from)|near\b|map/i.test(t)) add("location", 1.5, "location words");
  if (/price|aed|payment\s*plan|installment|instalment|service\s*charge|handover|sqft|sq\.?\s*ft|sqm|built\s*up|plot/i.test(t)) add("specs_schedule", 1.2 + Math.min(1.5, count(/\d[\d,.]{2,}/g) / 8), "areas / prices / schedule numbers");
  if (/specification|finishes|finish\s*schedule|material\s*palette|flooring|joinery|sanitary/i.test(t)) add("material_board", 1.5, "finish words");
  if (/disclaimer|subject\s*to\s*change|artist'?s?\s*impression|indicative|for\s*illustration|title\s*deed|certificate|registration|ownership|municipality/i.test(t)) add("legal_disclaimer", 1.8, "legal / disclaimer wording");
  if (/renders?\b|cgi|visuali[sz]ation/i.test(t)) add(/interior/i.test(t) ? "cgi_interior" : /exterior/i.test(t) ? "cgi_exterior" : "cgi_interior", 1.2, "render keyword");
  if (caption) add(INTERIOR_CAPTION.test(caption) ? "cgi_interior" : EXTERIOR_CAPTION.test(caption) ? "cgi_exterior" : "cgi_interior", 2.5, `caption "${caption}"`);

  // image signals: photographic = high colour spread and saturation, drawings = white + low saturation + edges
  const photo = (x: ImageStats) => x.colorStd > 45 && x.saturation > 0.12 && x.whiteRatio < 0.35;
  const drawing = (x: ImageStats) => x.whiteRatio > 0.25 && x.saturation < 0.12 && x.edgeDensity > 0.04;
  const photos = assetStats.filter(photo).length;
  const drawings = assetStats.filter(drawing).length;
  if (photos) add(caption && !INTERIOR_CAPTION.test(caption) ? "cgi_exterior" : rooms >= 1 && !levels ? "cgi_interior" : "cgi_interior", 0.6 + 0.3 * photos, `${photos} photographic image(s)`);
  if (drawings && (levels >= 1 || rooms >= 3 || dims >= 1)) add("unit_plan", 0.8 + 0.4 * drawings, `${drawings} line-drawing image(s) with level/room labels`);
  if (!assetStats.length && st) {
    // single-image scanned page: judge the whole page
    if (photo(st) && !caption) add(/sky|exterior|facade/i.test(t) || !rooms ? "cgi_exterior" : "cgi_interior", 1.4, "whole page is photographic");
    if (drawing(st) && rooms >= 2) add("unit_plan", 1, "whole page is a line drawing");
  }
  if (t.replace(/\s/g, "").length < 40 && st && st.whiteRatio > 0.8 && !photos) add("other", 1.5, "near-empty divider page");

  const entries = Object.entries(s).sort((a, b) => b[1] - a[1]) as Array<[PageLabel, number]>;
  const top = entries[0]?.[1] ?? 0;
  let labels = entries.filter(([, v]) => v >= 1.4 && v >= top * 0.45).map(([l]) => l);
  // a CGI-captioned page is not a plan, even when a small key plan sits beside the render
  if (caption && labels.includes("unit_plan") && (s.unit_plan ?? 0) < (s.cgi_interior ?? 0) + (s.cgi_exterior ?? 0)) labels = labels.filter((l) => l !== "unit_plan");
  if (!labels.length) labels = ["other"];
  const confidence = Math.max(0.2, Math.min(0.9, top / 5));
  return { labels, confidence, reason: why.slice(0, 6).join("; ") };
}

export function assetKindFor(p: PageRecord, a: AssetIndexEntry, st: ImageStats): AssetKind {
  const area = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const drawing = st.whiteRatio > 0.2 && st.saturation < 0.14;
  const photo = st.colorStd > 40 && st.saturation > 0.1 && !drawing;
  if (area < 0.03 && st.whiteRatio > 0.5) return "logo";
  if (drawing && (p.labels.includes("unit_plan") || p.labels.includes("typical_floor") || p.labels.includes("furniture_layout"))) {
    return p.labels.includes("typical_floor") ? "floor_plan" : "unit_plan";
  }
  if (drawing && p.labels.some((l) => l.startsWith("cgi_"))) return "key_plan";
  if (drawing && p.labels.includes("masterplan")) return "floor_plan";
  if (photo && p.labels.includes("cgi_exterior")) return "cgi_exterior";
  if (photo && p.labels.includes("cgi_interior")) return "cgi_interior";
  if (photo && p.labels.includes("amenities")) return "amenity";
  if (photo) return "photo";
  if (p.labels.includes("elevation")) return "elevation";
  if (p.labels.includes("material_board")) return "material_board";
  return "other";
}

/** Nearest text item to an asset box (below first, then above) — photo captions in brochures. */
export function captionFor(p: PageRecord, bbox: [number, number, number, number]): string | undefined {
  let best: { s: string; d: number } | undefined;
  for (const it of p.items) {
    const s = it.str.trim();
    if (s.length < 3 || s.length > 80) continue;
    const hOverlap = Math.min(bbox[2], it.bbox[2]) - Math.max(bbox[0], it.bbox[0]);
    if (hOverlap <= 0) continue;
    const below = it.bbox[1] - bbox[3], above = bbox[1] - it.bbox[3];
    const d = below >= -0.01 && below < 0.08 ? below : above >= -0.01 && above < 0.05 ? above + 0.03 : Infinity;
    if (d < (best?.d ?? Infinity)) best = { s, d };
  }
  return best?.s;
}

export const PLAN_LABELS: readonly PageLabel[] = ["unit_plan", "typical_floor", "furniture_layout"];
export const isPlanPage = (p: PageRecord) => p.labels.some((l) => PLAN_LABELS.includes(l));

/**
 * Pages of a plan the app found online: the search already said the file is a floor plan, so an image is a plan
 * and a PDF's pages keep what the local classifier sees, except that a PDF with no page recognised as a plan
 * has its drawing pages taken as plans.
 */
export function foundOnlineLabels(pages: PageRecord[], src: SourceRecord, stats: (p: PageRecord) => ImageStats[]) {
  const why = `found online (${src.origin?.match.replace("_", " ")} for ${src.origin?.planFor})`;
  const out = new Map<number, { labels: PageLabel[]; labelConfidence: number; labelReason: string }>();
  const mine = pages.filter((p) => p.sourceId === src.id);
  for (const p of mine) {
    if (src.kind === "image") { out.set(p.n, { labels: ["unit_plan"], labelConfidence: 0.7, labelReason: why }); continue; }
    const r = localClassify(p, p === mine[0], stats(p));
    out.set(p.n, { labels: r.labels, labelConfidence: r.confidence, labelReason: `${why}; local: ${r.reason}` });
  }
  if (src.kind === "pdf" && ![...out.values()].some((x) => x.labels.some((l) => PLAN_LABELS.includes(l)))) {
    for (const p of mine) {
      const st = p.stats ?? stats(p)[0];
      if (st && st.whiteRatio > 0.45 && st.saturation < 0.15) out.set(p.n, { labels: ["unit_plan"], labelConfidence: 0.5, labelReason: `${why}; drawing page` });
    }
  }
  return out;
}

export async function classifyAll(jobId: string) {
  const job = (await readJob(jobId))!;
  const assets = await readAssetIndex(jobId);
  const useClaude = extractorKind() !== "local";
  const firstPages = new Set(job.sources.map((s) => job.pages.find((p) => p.sourceId === s.id)?.n));
  const assetStats = new Map<string, ImageStats>();
  for (const a of assets) assetStats.set(a.id, await imageStats(jobFile(jobId, a.path)));
  // pages of plans found online are labelled from the search, not sent to the model again
  const found = new Map<number, { labels: PageLabel[]; labelConfidence: number; labelReason: string }>();
  for (const src of job.sources.filter((s) => s.origin)) {
    for (const [n, v] of foundOnlineLabels(job.pages, src, (p) => assets.filter((a) => a.page === p.n && a.origin === "pdf_crop").map((a) => assetStats.get(a.id)!))) found.set(n, v);
  }

  // start every page's model call up front, a few at a time; results are applied in page order
  const run = limiter(MODEL_CONCURRENCY);
  const modelOut = new Map(useClaude ? job.pages.filter((p) => !found.has(p.n)).map((p) => [p.n, settle(run(() => callStructured(jobId, {
    task: `classify page ${p.n}`, system: CLASSIFY_SYSTEM, schema: ClassifySchema, schemaName: "PageClassification",
    prompt: `Page ${p.n}. Extracted text (${p.textSource}):\n"""\n${p.text.slice(0, 6000)}\n"""`,
    images: [jobFile(jobId, p.image)],
  })))] as const) : []);

  for (const p of job.pages) {
    const mine = assets.filter((a) => a.page === p.n && a.origin === "pdf_crop");
    p.caption = p.caption ?? extractCaption(p);
    if (found.has(p.n)) {
      Object.assign(p, found.get(p.n));
    } else if (useClaude) {
      try {
        const r = await modelOut.get(p.n)!;
        if (!r.ok) throw r.error;
        const out = r.value;
        p.labels = out.labels.length ? out.labels : ["other"];
        p.labelConfidence = out.confidence;
        p.labelReason = `Model: ${out.reason}`;
        p.caption = out.caption ?? p.caption;
      } catch (e) {
        await log(jobId, "classify", `Page ${p.n}: model classification failed (${e instanceof Error ? e.message : e}); using local classifier.`, "warn");
        Object.assign(p, relabel(p, firstPages.has(p.n), mine.map((a) => assetStats.get(a.id)!)));
      }
    } else {
      Object.assign(p, relabel(p, firstPages.has(p.n), mine.map((a) => assetStats.get(a.id)!)));
    }
    await log(jobId, "classify", `Page ${p.n} → ${p.labels.join(", ")} (${Math.round(p.labelConfidence * 100)}%)${p.caption ? ` · caption "${p.caption}"` : ""}`);
  }

  // scanned render pages carry no embedded crops: cut the render, and the key plan printed beside it, out of the page image
  const cut = async (p: PageRecord, bb: [number, number, number, number], what: "render" | "key_plan") => {
    const file = jobFile(jobId, p.image);
    const left = Math.round(bb[0] * p.widthPx), top = Math.round(bb[1] * p.heightPx);
    const width = Math.min(p.widthPx - left, Math.round((bb[2] - bb[0]) * p.widthPx)), height = Math.min(p.heightPx - top, Math.round((bb[3] - bb[1]) * p.heightPx));
    const crop = await sharp(file).extract({ left, top, width, height }).png().toBuffer();
    const hash = await dHash(crop);
    const id = `a${p.n}-${hash.slice(0, 8)}`;
    await writeJobFile(jobId, `assets/${id}.png`, crop);
    const entry: AssetIndexEntry = { id, path: `assets/${id}.png`, page: p.n, bbox: bb, hash, w: width, h: height, sourceId: p.sourceId, origin: "pdf_crop", cut: what };
    assets.push(entry);
    assetStats.set(id, await imageStats(crop));
    await log(jobId, "classify", `Page ${p.n}: cut ${what === "render" ? "render" : "key plan"} out of scanned page (${Math.round((bb[2] - bb[0]) * 100)}% × ${Math.round((bb[3] - bb[1]) * 100)}% of page).`);
    return entry;
  };
  for (const p of job.pages) {
    if (!p.labels.some((l) => l === "cgi_interior" || l === "cgi_exterior")) continue;
    const scanned = p.textSource === "ocr" || p.textSource === "none";
    // crops of a scanned page were cut here (older runs did not mark them); a born-digital page's crops are its embedded images
    const crops = assets.filter((a) => a.page === p.n && a.origin === "pdf_crop").map((a) => (!a.cut && scanned ? { ...a, cut: "render" as const } : a));
    if (crops.some((a) => !a.cut)) continue;
    let render = crops.find((a) => a.cut === "render");
    if (!render) {
      const bb = await findPhotoRegion(jobFile(jobId, p.image));
      if (!bb) continue;
      render = await cut(p, bb, "render");
    }
    if (!crops.some((a) => a.cut === "key_plan")) {
      const kb = await findDrawingRegion(jobFile(jobId, p.image), render.bbox);
      if (kb) await cut(p, kb, "key_plan");
    }
  }

  // label assets from their page + own pixels; attach captions
  const labelled = assets.map((a) => {
    const p = job.pages.find((x) => x.n === a.page)!;
    const st = assetStats.get(a.id)!;
    const pageCgi = p.labels.find((l): l is "cgi_interior" | "cgi_exterior" => l === "cgi_interior" || l === "cgi_exterior");
    const kind: AssetKind = a.cut === "key_plan" ? "key_plan"
      : (a.cut === "render" || (!a.cut && a.origin === "pdf_crop" && (p.textSource === "ocr" || p.textSource === "none"))) && pageCgi ? pageCgi
      : a.origin === "pdf_crop" ? assetKindFor(p, a, st) : assetKindFor({ ...p, labels: p.labels }, { ...a, bbox: [0, 0, 1, 1] }, st);
    const caption = (a.origin === "pdf_crop" ? captionFor(p, a.bbox) ?? (p.textSource === "ocr" ? p.caption : undefined) : a.alt ?? p.caption);
    return { ...a, kind, caption, stats: st };
  });
  await writeJobFile(jobId, "assets-index.json", JSON.stringify(labelled, null, 2));
  await updateJob(jobId, (j) => { j.pages = job.pages; });
  const counts = job.pages.flatMap((p) => p.labels).reduce<Record<string, number>>((m, l) => ((m[l] = (m[l] ?? 0) + 1), m), {});
  await log(jobId, "classify", `Classified ${job.pages.length} page(s): ${Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(", ")}.`);
}

function relabel(p: PageRecord, first: boolean, stats: ImageStats[]) {
  const r = localClassify(p, first, stats);
  return { labels: r.labels, labelConfidence: r.confidence, labelReason: `local: ${r.reason}` };
}
