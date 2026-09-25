// When no source contains a floor plan, look for the unit's plans online and add what is found as new
// sources that say where they came from (the searches, the page, how well the plan matches).
//   - Claude Code mode: a request that Claude Code answers with its own web search and web fetch tools,
//     checking each candidate against the brochure (floors, rooms per floor, key plans, facade).
//   - any other mode: a best-effort search of the open web with no key; what it finds is marked unverified.
// A plan of another unit type or project is listed for the reviewer but never used for geometry.
import * as z from "zod/v4";
import path from "node:path";
import type { AssetKind, PageRecord, PlanSearch, PropertyDossier, SourceRecord } from "./schema";
import { callStructured, extractorKind, PendingAnswer, HANDOFF_DIR, handoffKey } from "./llm";
import { download, ingestUrl } from "./url-ingest";
import { jobFile, log, readJob, sha256, updateJob, writeJobFile } from "./store";
import { appendSources, isPrivateHost, readAssetIndex, safeName, type AssetIndexEntry } from "./ingest";
import { assetKindFor, foundOnlineLabels, isPlanPage } from "./classify";
import { imageStats } from "./image-stats";

const TASK = "find floor plans online";
const MAX_FILES = 6;

export const FindPlansSchema = z.object({
  queries: z.array(z.string()).describe("the web searches you ran, in order"),
  identified: z.string().describe("what the property is, as far as the sources and the search show (project, developer, community, unit type); say so when the exact unit type is unknown"),
  candidates: z.array(z.object({
    url: z.string().describe("direct URL of a floor plan PDF or image (preferred), or of a web page that shows the plan"),
    kind: z.enum(["pdf", "image", "page"]),
    title: z.string(),
    planFor: z.string().describe("the unit type, villa type or building the plan belongs to, as its source names it"),
    levels: z.array(z.string()).describe("the floors the plan shows, e.g. Ground floor, First floor"),
    match: z.enum(["exact", "same_type", "different"]).describe("exact: this very unit; same_type: the same unit type (same layout) in the same project; different: anything else, never used for geometry"),
    evidence: z.string().describe("what agrees or disagrees with the sources: number of floors, the rooms on each floor, key-plan shapes, the facade in the renders"),
  })),
  notes: z.string().describe("anything the reviewer should know, e.g. why nothing matched"),
});
export type FindPlansOut = z.infer<typeof FindPlansSchema>;

export const FIND_PLANS_SYSTEM = `The property's brochure and listing pages contain no floor plan. Find this property's floor plans online.
- Use your web search and web fetch tools. Start with the developer's and the project's own website, then property portals and floor-plan libraries that publish plans per project and unit type.
- Identify the property only from what the request gives you (project, developer, community, unit type, rooms, renders). Never use private documents such as title deeds or contracts to identify it or to search.
- Check every candidate against the sources: the same number of floors, the same rooms on the same floors, the key plans in the images drawn the same way, the massing and facade of the exterior renders.
- match "exact" only when the plan is of this very unit; "same_type" when it is the same unit type (same layout) in the same project; "different" for everything else, including other types in the same community. Being in the same community is not a match.
- Prefer direct URLs of the plan files (PDF, JPG, PNG, WEBP) that can be downloaded without logging in. If only a web page shows the plan, give the page with kind "page".
- List every candidate you checked, the ones that did not match too, so the reviewer can see the search. An empty list is a valid answer when nothing was found.`;

/** Levels named in render captions like "Ground floor - Formal living" → { "Ground floor": ["Formal living"] }. */
export function roomsByFloor(pages: PageRecord[]) {
  const out = new Map<string, string[]>();
  const re = /^\s*((?:lower\s+|upper\s+)?(?:basement|ground|first|second|third|fourth|roof\s*top|rooftop|roof|mezzanine|podium|level\s*\d+|\d+(?:st|nd|rd|th))(?:\s*floor)?)\s*[-–:|]\s*(.+?)\s*$/i;
  for (const p of pages) {
    const m = p.caption?.match(re);
    if (!m) continue;
    const floor = m[1].replace(/\s+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    const room = m[2].replace(/\s+/g, " ");
    const list = out.get(floor) ?? [];
    if (!list.some((r) => r.toLowerCase() === room.toLowerCase())) list.push(room);
    out.set(floor, list);
  }
  return out;
}

function brief(d: PropertyDossier, job: NonNullable<Awaited<ReturnType<typeof readJob>>>) {
  const listing = job.sources.filter((s) => s.kind === "url");
  const files = job.sources.filter((s) => s.kind !== "url" && !s.origin);
  const floors = roomsByFloor(job.pages);
  const facts = d.facts.filter((f) => !/^(copy|paragraph)/i.test(f.key)).slice(0, 30);
  const lines = [
    `Project: ${d.projectName ?? "not named in the sources"}${d.developer ? `; developer: ${d.developer}` : ""}${d.location ? `; location: ${d.location}` : ""}`,
    d.unitTypes.length ? `Unit types in the sources: ${d.unitTypes.map((u) => `${u.code}${u.beds ? ` (${u.beds} bed)` : ""}`).join(", ")}` : "No unit type is named in the sources.",
    job.unitFocus ? `Unit asked about: ${job.unitFocus}` : "",
    job.notes ? `Notes from the person who created the job: ${job.notes}` : "",
    listing.length ? `Listing pages: ${listing.map((s) => `${s.url}${s.meta?.title ? ` (${s.meta.title})` : ""}`).join("; ")}` : "",
    files.length ? `Files: ${files.map((s) => s.name).join("; ")}` : "",
    floors.size ? `Rooms named in the render captions, by floor:\n${[...floors].map(([f, rs]) => `  - ${f}: ${rs.join(", ")}`).join("\n")}` : "",
    facts.length ? `Facts read so far:\n${facts.map((f) => `  - ${f.key} = ${f.value}`).join("\n")}` : "",
  ].filter(Boolean);
  const textPages = [...job.pages].filter((p) => p.text.trim().length > 80).sort((a, b) => b.text.length - a.text.length).slice(0, 3);
  if (textPages.length) lines.push(`Text from the sources:\n${textPages.map((p) => `"""(page ${p.n})\n${p.text.slice(0, 1500)}\n"""`).join("\n")}`);
  return lines.join("\n");
}

/** Search phrases for the automatic path, most specific first. */
export function searchQueries(d: PropertyDossier, unitFocus?: string) {
  const project = d.projectName?.trim();
  const unit = unitFocus?.trim() || d.unitTypes[0]?.code;
  const beds = d.unitTypes.find((u) => u.beds)?.beds;
  const place = d.location?.split(",")[0]?.trim();
  const kind = /villa/i.test(JSON.stringify(d.facts).slice(0, 20000)) ? "villa" : /townhouse/i.test(JSON.stringify(d.facts).slice(0, 20000)) ? "townhouse" : "";
  const qs = [
    project && unit ? `"${project}" ${unit} floor plan` : "",
    project ? `"${project}" floor plans${d.developer ? ` ${d.developer}` : ""}` : "",
    place && beds ? `${place} ${beds} bedroom ${kind || "unit"} floor plan` : "",
    place && !project ? `${place} ${kind || "property"} floor plans` : "",
  ].filter(Boolean);
  return [...new Set(qs)].slice(0, 4);
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PLAN_WORD = /floor[\s_-]*plans?|floorplans?|layouts?|unit[\s_-]*plans?|\bplans?\b/i;

/** Best-effort web search with no key (Bing's HTML results). Returns [] when the engine answers with a challenge or junk. */
export async function searchWeb(q: string): Promise<Array<{ url: string; title: string; snippet: string }>> {
  try {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US&cc=US&count=20`, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const html = await res.text();
    const out: Array<{ url: string; title: string; snippet: string }> = [];
    for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<cite>([\s\S]*?)<\/cite>)?[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g)) {
      const strip = (s = "") => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').trim();
      let url = strip(m[3]).replace(/\s*›\s*/g, "/");
      const href = m[1].replace(/&amp;/g, "&");
      if (!/^https?:/.test(url)) url = href;
      out.push({ url: /^https?:\/\//.test(url) ? url : href, title: strip(m[2]), snippet: strip(m[4]) });
    }
    // keep results that mention a distinctive word of the query: engines that throttle bots answer with unrelated pages
    const words = q.toLowerCase().replace(/"/g, "").split(/\s+/).filter((w) => w.length > 3 && !/^(floor|plans?|bedroom|villa|unit|property|townhouse)$/.test(w));
    return out.filter((r) => words.some((w) => `${r.title} ${r.url} ${r.snippet}`.toLowerCase().includes(w)));
  } catch {
    return [];
  }
}

async function automaticSearch(jobId: string, d: PropertyDossier, unitFocus?: string): Promise<FindPlansOut> {
  const queries = searchQueries(d, unitFocus);
  const seen = new Set<string>();
  const candidates: FindPlansOut["candidates"] = [];
  for (const q of queries) {
    const results = await searchWeb(q);
    await log(jobId, "extract", `Web search "${q}": ${results.length} relevant result(s).`);
    for (const r of results) {
      if (seen.has(r.url) || !PLAN_WORD.test(`${r.title} ${r.url} ${r.snippet}`)) continue;
      seen.add(r.url);
      const kind = /\.pdf(\?|$)/i.test(r.url) ? "pdf" : /\.(png|jpe?g|webp)(\?|$)/i.test(r.url) ? "image" : "page";
      candidates.push({ url: r.url, kind, title: r.title, planFor: unitFocus || d.projectName || "unknown", levels: [], match: "different", evidence: `automatic search result for "${q}"; not checked against the brochure` });
    }
    if (candidates.length >= 4) break;
  }
  return { queries, identified: d.projectName ?? "", candidates: candidates.slice(0, 4), notes: queries.length ? "" : "Not enough is known about the property (no project name or location) to search for it." };
}

type Fetched = { src: SourceRecord; data: Buffer };

/** Download a candidate: a PDF or image as is, or the plan files a web page shows. */
async function fetchCandidate(c: FindPlansOut["candidates"][number], origin: NonNullable<SourceRecord["origin"]>, known: Set<string>): Promise<{ files: Fetched[]; error?: string }> {
  if (!/^https?:\/\//i.test(c.url)) return { files: [], error: "not a web address" };
  if (await isPrivateHost(c.url)) return { files: [], error: "private network address" };
  const asSource = (url: string, data: Buffer, kind: "pdf" | "image"): Fetched | null => {
    const hash = sha256(data);
    if (known.has(hash)) return null;
    known.add(hash);
    const base = path.basename(new URL(url).pathname) || (kind === "pdf" ? "plan.pdf" : "plan.png");
    return {
      src: { id: hash.slice(0, 12), kind, name: `${c.title || base} (found online)`, path: `source/${hash.slice(0, 12)}-${safeName(base)}`, url, bytes: data.length, sha256: hash, status: "ok", origin: { ...origin, pageUrl: c.url } },
      data,
    };
  };
  const fileFrom = async (url: string) => {
    const got = await download(url, 60 * 1024 * 1024);
    if (!got) return null;
    if (got.data.subarray(0, 5).toString() === "%PDF-") return asSource(url, got.data, "pdf");
    const sharp = (await import("sharp")).default;
    const m = await sharp(got.data).metadata().catch(() => null);
    if (!m?.width || m.width < 300 || (m.height ?? 0) < 200) return null;
    return asSource(url, got.data, "image");
  };
  if (c.kind !== "page") {
    const f = await fileFrom(c.url);
    return f ? { files: [f] } : { files: [], error: "could not download a PDF or image from this address" };
  }
  const u = await ingestUrl(c.url);
  if (u.blocked) return { files: [], error: u.blockReason };
  const wanted = [
    ...u.pdfLinks.filter((l) => PLAN_WORD.test(decodeURIComponent(l))),
    ...u.images.filter((im) => PLAN_WORD.test(`${im.alt} ${decodeURIComponent(im.src)}`)).map((im) => im.src),
  ];
  const files: Fetched[] = [];
  for (const url of [...new Set(wanted)].slice(0, 4)) {
    const f = await fileFrom(url);
    if (f) files.push(f);
  }
  return files.length ? { files } : { files: [], error: "no plan file found on the page" };
}

/**
 * Called by extraction when no page of any source is a floor plan. Adds the plans it finds as sources,
 * ingests and labels their pages, and records the search on the job. Returns the new pages and assets.
 */
export async function findPlansOnline(jobId: string, d: PropertyDossier) {
  const job = (await readJob(jobId))!;
  const warnings: string[] = [];
  const empty = { pages: [] as PageRecord[], assets: [] as Array<AssetIndexEntry & { kind: AssetKind; caption?: string }>, warnings };
  const claudeCode = extractorKind() === "claude-code";
  const foundBy = claudeCode ? "Claude Code web search" : "automatic web search";
  let out: FindPlansOut;
  try {
    if (claudeCode) {
      const renders = job.pages.filter((p) => p.labels.includes("cgi_exterior")).slice(0, 2);
      const assets = await readAssetIndex(jobId) as Array<AssetIndexEntry & { kind?: AssetKind }>;
      const keyPlans = assets.filter((a) => a.kind === "key_plan").slice(0, 4);
      out = await callStructured(jobId, {
        task: TASK, system: FIND_PLANS_SYSTEM, schema: FindPlansSchema, schemaName: "FindPlans",
        prompt: `${brief(d, job)}\n\nImages: ${renders.length} exterior render(s) of the property first, then ${keyPlans.length} key plan(s) from the brochure. Use them to check that a plan you find is this property.`,
        images: [...renders.map((p) => jobFile(jobId, p.image)), ...keyPlans.map((a) => jobFile(jobId, a.path))],
      });
    } else {
      out = await automaticSearch(jobId, d, job.unitFocus);
    }
  } catch (e) {
    const waiting = e instanceof PendingAnswer;
    const search: PlanSearch = { at: new Date().toISOString(), status: waiting ? "waiting" : "failed", foundBy, queries: [], candidates: [], notes: waiting ? undefined : String(e instanceof Error ? e.message : e) };
    await updateJob(jobId, (j) => { j.planSearch = search; });
    warnings.push(waiting
      ? `No floor plan in the sources. Waiting for Claude Code to search for the plans online (${HANDOFF_DIR}/${handoffKey(TASK)}/request.md).`
      : `No floor plan in the sources, and the search for plans online failed: ${search.notes}`);
    return empty;
  }

  // download what matches; the automatic path cannot check a match, so it keeps its results as unverified
  const known = new Set(job.sources.map((s) => s.sha256));
  const fetched: Fetched[] = [];
  const candidates: PlanSearch["candidates"] = [];
  for (const c of out.candidates) {
    const usable = claudeCode ? c.match === "exact" || c.match === "same_type" : true;
    const match = claudeCode ? c.match : "unverified";
    const row = { url: c.url, title: c.title, planFor: c.planFor, levels: c.levels, match, evidence: c.evidence, used: false } as PlanSearch["candidates"][number];
    if (usable && fetched.length < MAX_FILES) {
      const already = job.sources.filter((s) => s.origin?.pageUrl === c.url);
      if (already.length) row.used = true;
      else {
        const r = await fetchCandidate(c, { kind: "web-search", foundBy, queries: out.queries, pageUrl: c.url, planFor: c.planFor, match: match as "exact" | "same_type" | "unverified", evidence: c.evidence }, known);
        fetched.push(...r.files);
        row.used = r.files.length > 0;
        if (r.error) row.error = r.error;
      }
    }
    candidates.push(row);
  }
  const used = candidates.filter((c) => c.used);
  const search: PlanSearch = { at: new Date().toISOString(), status: used.length ? "found" : "none", foundBy, queries: out.queries, identified: out.identified, candidates, notes: out.notes };
  await updateJob(jobId, (j) => { j.planSearch = search; });
  await log(jobId, "extract", `Floor plans online (${foundBy}): ${out.queries.length} search(es), ${candidates.length} candidate(s), ${used.length} used.${out.notes ? ` ${out.notes}` : ""}`, used.length ? "info" : "warn");
  for (const c of candidates) await log(jobId, "extract", `  ${c.used ? "USED" : c.match === "different" ? "not this unit" : "skipped"}: ${c.title} (${c.planFor}; ${c.match}) ${c.url}${c.error ? ` — ${c.error}` : ""}`);
  if (!used.length) {
    warnings.push(`No floor plan in the sources, and none of the ${candidates.length} plan(s) found online is this unit${out.notes ? ` (${out.notes})` : ""}. Rooms come from the brochure's own drawings only.`);
    return empty;
  }
  for (const c of used) warnings.push(`Floor plan found online, not in the brochure: ${c.title} (${c.match === "unverified" ? "unverified match, check it" : c.match.replace("_", " ")}) from ${c.url}.`);
  if (!fetched.length) return empty; // found on an earlier run and already ingested

  // ingest the files, label their pages as plans and their images as plan assets
  for (const f of fetched) await writeJobFile(jobId, f.src.path!, f.data);
  const added = await appendSources(jobId, fetched);
  const after = (await readJob(jobId))!;
  const labelled: Array<AssetIndexEntry & { kind: AssetKind; caption?: string }> = [];
  const stats = new Map(await Promise.all(added.assets.map(async (a) => [a.id, await imageStats(jobFile(jobId, a.path))] as const)));
  for (const src of fetched.map((f) => after.sources.find((s) => s.id === f.src.id)!).filter(Boolean)) {
    for (const [n, v] of foundOnlineLabels(added.pages, src, (p) => added.assets.filter((a) => a.page === p.n && a.origin === "pdf_crop").map((a) => stats.get(a.id)!))) {
      Object.assign(added.pages.find((p) => p.n === n)!, v);
    }
  }
  for (const a of added.assets) {
    const p = added.pages.find((x) => x.n === a.page)!;
    const src = after.sources.find((s) => s.id === a.sourceId);
    const kind: AssetKind = src?.kind === "image" && isPlanPage(p) ? "unit_plan" : assetKindFor(p, a, stats.get(a.id)!);
    labelled.push({ ...a, kind, caption: a.alt ?? p.caption });
  }
  const index = (await readAssetIndex(jobId)).map((a) => labelled.find((x) => x.id === a.id) ?? a);
  await writeJobFile(jobId, "assets-index.json", JSON.stringify(index, null, 2));
  await updateJob(jobId, (j) => { for (const p of added.pages) { const q = j.pages.find((x) => x.n === p.n); if (q) Object.assign(q, { labels: p.labels, labelConfidence: p.labelConfidence, labelReason: p.labelReason }); } });
  await log(jobId, "extract", `Added ${fetched.length} plan file(s) found online: ${added.pages.length} page(s), ${added.pages.filter(isPlanPage).length} recognised as plans.`);
  return { pages: added.pages, assets: labelled, warnings };
}
