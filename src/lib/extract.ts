// Stage 3: build the Property Dossier from classified pages and assets.
import type { Asset, AssetKind, PropertyDossier } from "./schema";
import { emptyDossier } from "./schema";
import { log, readJob, writeDossier, readDossier } from "./store";
import { readAssetIndex, type AssetIndexEntry } from "./ingest";
import { claudeFacts, localFacts } from "./extract-facts";
import { extractPlans } from "./extract-plan";
import { extractMaterials } from "./extract-materials";
import { extractorKind, extractorLabel } from "./llm";
import { normalizeDossier } from "./normalize";

export async function extractAll(jobId: string): Promise<PropertyDossier> {
  const job = (await readJob(jobId))!;
  const assets = (await readAssetIndex(jobId)) as Array<AssetIndexEntry & { kind: AssetKind; caption?: string }>;
  const useClaude = extractorKind() !== "local";
  await log(jobId, "extract", useClaude ? `Extractor: ${extractorLabel()} (vision, structured outputs).` : "Extractor: local (text layer, OCR, image signals). Set ANTHROPIC_API_KEY for vision plan tracing.");
  const d = emptyDossier(jobId);
  d.unitFocus = job.unitFocus;

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
      for (const f of cf.facts) if (!d.facts.some((x) => x.key === f.key && x.value === f.value)) d.facts.push(f);
      for (const u of cf.unitTypes) if (!d.unitTypes.some((x) => x.id === u.id)) d.unitTypes.push(u);
      d.warnings.push(...cf.warnings);
    } catch (e) {
      d.warnings.push(`Vision fact extraction failed (${e instanceof Error ? e.message : e}); local facts only.`);
    }
  }
  for (const f of d.facts.slice(0, 200)) await log(jobId, "extract", `${f.key} = ${f.value}  [${f.evidence[0]?.ref}]`, "fact");

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

  // B. plans
  const ceil = d.facts.find((f) => f.key === "ceiling_height_m");
  const plans = await extractPlans(jobId, job.pages, assets, d.unitTypes, useClaude, ceil ? { value: Number(ceil.value), evidence: ceil.evidence[0] } : undefined);
  d.levels = plans.levels;
  d.unitTypes = plans.unitTypes;
  d.northDeg = plans.northDeg;
  d.warnings.push(...plans.warnings);
  // unit focus from the user's note ("Type C, 2BR + Maid, Level 22")
  const focus = (job.unitFocus ?? "").toLowerCase();
  d.selectedUnitTypeId = (focus && d.unitTypes.find((u) => focus.includes(u.code.toLowerCase()))?.id) || d.unitTypes.find((u) => u.levelIds.length)?.id || d.unitTypes[0]?.id;

  // C. materials
  const mats = await extractMaterials(jobId, job.pages, assets, useClaude);
  d.materials = mats.materials;
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
