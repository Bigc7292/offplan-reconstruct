// Stage 3: build the Property Dossier from classified pages and assets.
import type { Asset, AssetKind, PropertyDossier } from "./schema";
import { emptyDossier } from "./schema";
import { log, readJob, writeDossier, readDossier, writeJobFile } from "./store";
import { readAssetIndex, type AssetIndexEntry } from "./ingest";
import { claudeFacts, localFacts } from "./extract-facts";
import { extractPlans } from "./extract-plan";
import { extractMaterials } from "./extract-materials";
import { extractorKind, extractorLabel } from "./llm";
import { findPlansOnline } from "./find-plans";
import { isPlanPage } from "./classify";
import { normalizeDossier } from "./normalize";
import { reconstruct } from "./reconstruct";
import { settle } from "./concurrency";

export async function extractAll(jobId: string): Promise<PropertyDossier> {
  const job = (await readJob(jobId))!;
  const assets = (await readAssetIndex(jobId)) as Array<AssetIndexEntry & { kind: AssetKind; caption?: string }>;
  const useClaude = extractorKind() !== "local";
  await log(jobId, "extract", useClaude ? `Extractor: ${extractorLabel()} (vision, structured outputs).` : "Extractor: local (text layer, OCR, image signals). Set ANTHROPIC_API_KEY for vision plan tracing.");
  const d = emptyDossier(jobId);
  d.unitFocus = job.unitFocus;

  // assets → dossier
  d.assets = assets.map<Asset>((a) => ({ id: a.id, kind: a.kind, path: a.path, caption: a.caption, page: a.page }));
  for (const p of job.pages) {
    // scanned single-image pages have no crops: the page itself is the asset
    if (!assets.some((a) => a.page === p.n)) {
      const kind: AssetKind = p.labels.includes("cgi_interior") ? "cgi_interior" : p.labels.includes("cgi_exterior") ? "cgi_exterior" : p.labels.includes("unit_plan") ? "unit_plan" : "other";
      const pageAsset = { id: `page-${p.n}`, kind, path: p.image, caption: p.caption, page: p.n };
      d.assets.push(pageAsset);
      assets.push({ ...pageAsset, bbox: [0, 0, 1, 1], hash: "", w: p.widthPx, h: p.heightPx, sourceId: p.sourceId, origin: "page" });
    }
  }

  // C. materials read the renders independently of facts and plans, so start them now
  const matsP = settle(extractMaterials(jobId, job.pages, assets, useClaude));

  // A. facts (local pass always runs: it keeps every paragraph; Claude adds structured facts on top)
  const lf = localFacts(job.pages, job.sources.map((s) => s.meta));
  d.copy = lf.copy;
  d.facts = lf.facts;
  d.unitTypes = lf.unitTypes;
  d.warnings.push(...lf.warnings);
  d.projectName = lf.projectName;
  d.location = lf.location;
  if (useClaude) {
    try {
      const cf = await claudeFacts(jobId, job.pages);
      d.projectName = cf.projectName ?? d.projectName;
      d.developer = cf.developer ?? d.developer;
      d.location = cf.location ?? d.location;
      // the model read every page: keep the local pass's facts only where the model has no fact of that kind and the
      // text is the brochure's own text layer. A web page can describe a whole community (every villa collection,
      // their bedroom counts and plot sizes), and pattern-matching its numbers would pin them on this unit.
      const pageOf = (ref?: string) => job.pages.find((p) => `page-${p.n}` === ref);
      const modelKeys = new Set(cf.facts.map((f) => f.key));
      const dropped = d.facts.filter((f) => modelKeys.has(f.key) || pageOf(f.evidence[0]?.ref)?.textSource !== "text_layer");
      d.facts = d.facts.filter((f) => !dropped.includes(f));
      if (dropped.length) await log(jobId, "extract", `Kept the model's facts over ${dropped.length} pattern-matched one(s) from OCR or web text.`);
      for (const f of cf.facts) if (!d.facts.some((x) => x.key === f.key && x.value === f.value)) d.facts.push(f);
      for (const u of cf.unitTypes) if (!d.unitTypes.some((x) => x.id === u.id)) d.unitTypes.push(u);
      d.warnings.push(...cf.warnings);
    } catch (e) {
      d.warnings.push(`Vision fact extraction failed (${e instanceof Error ? e.message : e}); local facts only.`);
    }
  }
  for (const f of d.facts.slice(0, 200)) await log(jobId, "extract", `${f.key} = ${f.value}  [${f.evidence[0]?.ref}]`, "fact");

  // B0. no floor plan in any source: look for the unit's plans online; what is found becomes a source of its own
  let pages = job.pages;
  if (!pages.some(isPlanPage)) {
    const found = await findPlansOnline(jobId, d);
    d.warnings.push(...found.warnings);
    if (found.pages.length) {
      pages = [...pages, ...found.pages];
      assets.push(...found.assets);
      d.assets.push(...found.assets.map<Asset>((a) => ({ id: a.id, kind: a.kind, path: a.path, caption: a.caption, page: a.page })));
    }
  }

  // B. plans
  const ceil = d.facts.find((f) => f.key === "ceiling_height_m");
  const plans = await extractPlans(jobId, pages, assets, d.unitTypes, useClaude, ceil ? { value: Number(ceil.value), evidence: ceil.evidence[0] } : undefined,
    (levels) => writePreview(jobId, d, levels));
  d.levels = plans.levels;
  d.unitTypes = plans.unitTypes;
  d.northDeg = plans.northDeg;
  d.warnings.push(...plans.warnings);
  // unit focus from the user's note ("Type C, 2BR + Maid, Level 22")
  const focus = (job.unitFocus ?? "").toLowerCase();
  d.selectedUnitTypeId = (focus && d.unitTypes.find((u) => focus.includes(u.code.toLowerCase()))?.id) || d.unitTypes.find((u) => u.levelIds.length)?.id || d.unitTypes[0]?.id;

  const matsR = await matsP;
  if (!matsR.ok) throw matsR.error;
  const mats = matsR.value;
  d.materials = mats.materials;
  if ("exterior" in mats && mats.exterior) d.exterior = mats.exterior;
  d.facts.push(...mats.facts);
  d.warnings.push(...mats.warnings);

  // D. disclaimers & source notes
  const cgiCount = d.assets.filter((a) => a.kind.startsWith("cgi")).length;
  if (cgiCount) d.warnings.push(`${cgiCount} render(s) are artist impressions; finishes shown may differ from the delivered unit.`);
  for (const s of job.sources) if (s.status === "blocked") d.warnings.push(`${s.name}: blocked (${s.error}). Upload the brochure PDF instead.`);
  d.warnings = [...new Set(d.warnings)];

  // keep any human edits from an earlier review if re-extracting? No: extraction replaces the dossier, but the
  // previous one is preserved alongside for reference.
  const prev = await readDossier(jobId);
  if (prev?.reviewedAt) {
    const { writeJobFile } = await import("./store");
    await writeJobFile(jobId, `dossier.previous.json`, JSON.stringify(prev, null, 2));
    await log(jobId, "extract", "Previous reviewed dossier saved as dossier.previous.json.", "warn");
  }
  const saved = await writeDossier(jobId, normalizeDossier(d));
  const placed = saved.levels.reduce((n, l) => n + l.rooms.filter((r) => r.polygon.length >= 3).length, 0);
  const listed = saved.levels.reduce((n, l) => n + l.rooms.length, 0);
  await log(jobId, "extract", `Dossier: ${saved.facts.length} facts, ${saved.unitTypes.length} unit type(s), ${saved.levels.length} level(s), ${listed} room(s) (${placed} placed), ${saved.materials.length} material(s), ${saved.warnings.length} warning(s).`);
  return saved;
}

/**
 * While plans are still being read, rebuild a rough 3D preview from the floors finished so far,
 * so the person waiting can watch the model take shape. Best effort: a failure never stops extraction.
 */
async function writePreview(jobId: string, d: PropertyDossier, levels: PropertyDossier["levels"]) {
  try {
    const partial = normalizeDossier({ ...d, levels: structuredClone(levels), selectedUnitTypeId: undefined });
    const g = reconstruct(partial);
    await writeJobFile(jobId, "preview-scene.json", JSON.stringify({ ...g, preview: { levelsRead: levels.length, updatedAt: new Date().toISOString() } }));
  } catch (e) {
    await log(jobId, "extract", `Live preview skipped: ${e instanceof Error ? e.message : e}`, "warn");
  }
}
