// Stage 0 (register sources) and Stage 1 (ingest) for every input kind.
import path from "node:path";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";
import sharp from "sharp";
import type { PageRecord, SourceRecord, TextItem } from "./schema";
import { jobFile, log, readJob, sha256, updateJob, writeJobFile } from "./store";
import { detectLanguages, ingestPdf, type IngestedAsset } from "./pdf";
import { download, flattenJsonLd, ingestUrl } from "./url-ingest";
import { dHash, hamming, imageStats } from "./image-stats";
import { ocrImage } from "./ocr";
import type { NewJobInput } from "./pipeline";

export type AssetIndexEntry = IngestedAsset & { sourceId: string; alt?: string; origin: "pdf_crop" | "page" | "url_image" | "upload" };

const safeName = (s: string) => s.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);

export async function registerSources(jobId: string, input: NewJobInput) {
  const sources: SourceRecord[] = [];
  if (input.demo) {
    sources.push({ id: "demo", kind: "demo", name: "Built-in DEMO unit", sha256: "demo", status: "ok" });
  }
  for (const f of input.files) {
    const hash = sha256(f.data);
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name) || f.data.subarray(0, 5).toString() === "%PDF-";
    const isImg = /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|tiff?)$/i.test(f.name);
    if (!isPdf && !isImg) {
      await log(jobId, "create", `Skipped ${f.name}: only PDF and image files are supported.`, "warn");
      continue;
    }
    if (sources.some((s) => s.sha256 === hash)) {
      await log(jobId, "create", `Skipped ${f.name}: identical to another uploaded file.`, "warn");
      continue;
    }
    const rel = `source/${hash.slice(0, 12)}-${safeName(f.name)}`;
    await writeJobFile(jobId, rel, f.data);
    sources.push({ id: hash.slice(0, 12), kind: isPdf ? "pdf" : "image", name: f.name, path: rel, bytes: f.data.length, sha256: hash, status: "ok" });
  }
  for (const u of input.urls) {
    const hash = sha256(u);
    sources.push({ id: `u${hash.slice(0, 11)}`, kind: "url", name: u, url: u, sha256: hash, status: "ok" });
  }
  await updateJob(jobId, (j) => { j.sources = sources; });
}

async function isPrivateHost(url: string) {
  if (process.env.ALLOW_PRIVATE_URLS === "1") return false;
  const host = new URL(url).hostname;
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  return addrs.some((a) => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80)/i.test(a));
}

export async function ingestAll(jobId: string) {
  const job = (await readJob(jobId))!;
  const pages: PageRecord[] = [];
  const assets: AssetIndexEntry[] = [];
  const extraSources: SourceRecord[] = [];
  const nextN = () => pages.length + 1;

  const addPdf = async (src: SourceRecord, data: Buffer) => {
    await log(jobId, "ingest", `Rasterising ${src.name}…`);
    const res = await ingestPdf(jobId, src.id, data, nextN());
    src.pageCount = res.pages.length;
    src.meta = res.meta;
    pages.push(...res.pages);
    assets.push(...res.assets.map((a) => ({ ...a, sourceId: src.id, origin: "pdf_crop" as const })));
    await log(jobId, "ingest", `${src.name}: ${res.pages.length} page(s), ${res.assets.length} embedded image(s) extracted.`);
  };

  const addImage = async (src: SourceRecord, data: Buffer, alt?: string, origin: AssetIndexEntry["origin"] = "upload") => {
    const n = nextN();
    const png = await sharp(data).rotate().resize(2600, 2600, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(png).metadata();
    const hash = await dHash(png);
    if (assets.some((a) => hamming(a.hash, hash) <= 3)) {
      await log(jobId, "ingest", `Skipped ${alt ?? src.name}: perceptual duplicate of an image already ingested.`);
      return;
    }
    const rel = `pages/${n}.png`;
    await writeJobFile(jobId, rel, png);
    await writeJobFile(jobId, `pages/${n}.thumb.jpg`, await sharp(png).resize(360).jpeg({ quality: 78 }).toBuffer());
    let text = alt ?? "", items: TextItem[] = [], textSource: PageRecord["textSource"] = alt ? "html" : "none";
    const ocr = await ocrImage(jobFile(jobId, rel), meta.width!, meta.height!);
    if (ocr && ocr.items.length) { text = [alt, ocr.text].filter(Boolean).join("\n"); items = ocr.items; textSource = "ocr"; }
    await writeJobFile(jobId, `pages/${n}.txt`, text);
    pages.push({
      n, sourceId: src.id, sourcePage: 1, image: rel, thumb: `pages/${n}.thumb.jpg`, widthPx: meta.width!, heightPx: meta.height!,
      text, textSource, items, languages: detectLanguages(text), labels: [], labelConfidence: 0, labelReason: "", caption: alt, stats: await imageStats(png),
    });
    assets.push({ id: `a${n}-${hash.slice(0, 8)}`, path: rel, page: n, bbox: [0, 0, 1, 1], hash, w: meta.width!, h: meta.height!, sourceId: src.id, alt, origin });
  };

  for (const src of job.sources) {
    try {
      if (src.kind === "pdf") await addPdf(src, await fs.readFile(jobFile(jobId, src.path!)));
      else if (src.kind === "image") await addImage(src, await fs.readFile(jobFile(jobId, src.path!)), undefined, "upload");
      else if (src.kind === "url") {
        if (await isPrivateHost(src.url!)) {
          src.status = "blocked";
          src.error = "private network address";
          await log(jobId, "ingest", `${src.url}: refused (private network address).`, "warn");
          continue;
        }
        await log(jobId, "ingest", `Fetching ${src.url}…`);
        const u = await ingestUrl(src.url!);
        if (u.html) await writeJobFile(jobId, `source/${src.id}.html`, u.html);
        src.path = u.html ? `source/${src.id}.html` : undefined;
        if (u.blocked) {
          src.status = "blocked";
          src.error = u.blockReason;
          await log(jobId, "ingest", `${src.url} is blocked (${u.blockReason}). Please upload the brochure PDF instead — pages behind logins are never scraped.`, "warn");
          continue;
        }
        src.meta = { title: u.title ?? "", finalUrl: u.finalUrl, ...Object.fromEntries(Object.entries(u.og).slice(0, 20)) };
        // the page itself: screenshot (or OG image) + every visible paragraph + OG + JSON-LD lines
        const ldLines = u.jsonLd.flatMap((x) => flattenJsonLd(x)).map(([k, v]) => `${k}: ${v}`);
        const ogLines = Object.entries(u.og).map(([k, v]) => `${k}: ${v}`);
        const text = [u.title, ...u.paragraphs, ...ogLines.map((l) => `[meta] ${l}`), ...ldLines.map((l) => `[json-ld] ${l}`)].filter(Boolean).join("\n");
        await writeJobFile(jobId, `source/${src.id}.jsonld.json`, JSON.stringify(u.jsonLd, null, 2));
        const n = nextN();
        const shot = u.screenshot ? await sharp(u.screenshot).resize(1440, 6000, { fit: "inside" }).png().toBuffer() : await textCard(u.title ?? src.url!, src.url!);
        const meta = await sharp(shot).metadata();
        await writeJobFile(jobId, `pages/${n}.png`, shot);
        await writeJobFile(jobId, `pages/${n}.thumb.jpg`, await sharp(shot).resize(360, 480, { fit: "cover", position: "top" }).jpeg({ quality: 78 }).toBuffer());
        await writeJobFile(jobId, `pages/${n}.txt`, text);
        pages.push({
          n, sourceId: src.id, sourcePage: 1, image: `pages/${n}.png`, thumb: `pages/${n}.thumb.jpg`, widthPx: meta.width!, heightPx: meta.height!,
          text, textSource: "html", items: [], languages: detectLanguages(text), labels: [], labelConfidence: 0, labelReason: "", caption: u.title,
        });
        await log(jobId, "ingest", `${src.url}: ${u.paragraphs.length} text block(s), ${u.images.length} image(s), ${u.jsonLd.length} JSON-LD block(s), ${u.pdfLinks.length} linked PDF(s)${u.screenshot ? ", screenshot captured" : ", no browser for screenshot"}.`);
        for (const img of u.images.slice(0, 30)) {
          const got = await download(img.src, 25 * 1024 * 1024);
          if (!got) continue;
          const m = await sharp(got.data).metadata().catch(() => null);
          if (!m || (m.width ?? 0) < 320 || (m.height ?? 0) < 200) continue; // icons, avatars, trackers
          await addImage({ ...src }, got.data, img.alt || undefined, "url_image");
        }
        for (const pdfUrl of u.pdfLinks.slice(0, 3)) {
          if (await isPrivateHost(pdfUrl)) continue;
          const got = await download(pdfUrl);
          if (!got || got.data.subarray(0, 5).toString() !== "%PDF-") continue;
          const hash = sha256(got.data);
          if ([...job.sources, ...extraSources].some((s) => s.sha256 === hash)) {
            await log(jobId, "ingest", `${pdfUrl} is the same file as an uploaded source; not ingested twice.`);
            continue;
          }
          const rel = `source/${hash.slice(0, 12)}-${safeName(path.basename(new URL(pdfUrl).pathname))}`;
          await writeJobFile(jobId, rel, got.data);
          const child: SourceRecord = { id: hash.slice(0, 12), kind: "pdf", name: `${path.basename(new URL(pdfUrl).pathname)} (linked from ${new URL(src.url!).hostname})`, path: rel, url: pdfUrl, bytes: got.data.length, sha256: hash, status: "ok" };
          extraSources.push(child);
          await addPdf(child, got.data);
        }
      }
    } catch (e) {
      src.status = "error";
      src.error = e instanceof Error ? e.message : String(e);
      await log(jobId, "ingest", `${src.name}: ingest failed — ${src.error}`, "error");
    }
  }
  const langs = new Set(pages.flatMap((p) => p.languages));
  await log(jobId, "ingest", `Ingest complete: ${pages.length} page(s), ${assets.length} asset(s). Languages: ${[...langs].join(", ") || "none detected"}.`);
  await writeJobFile(jobId, "assets-index.json", JSON.stringify(assets, null, 2));
  await updateJob(jobId, (j) => {
    j.pages = pages;
    j.sources = [...job.sources, ...extraSources];
  });
  if (!pages.length) throw new Error("Nothing could be ingested. Upload a brochure PDF or plan image.");
}

async function textCard(title: string, url: string) {
  const esc = (s: string) => s.replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="100%" height="100%" fill="#1b1917"/><text x="60" y="360" font-family="Helvetica" font-size="44" fill="#e8dcc4">${esc(title.slice(0, 60))}</text><text x="60" y="420" font-family="Helvetica" font-size="24" fill="#8f8677">${esc(url.slice(0, 90))}</text><text x="60" y="740" font-family="Helvetica" font-size="20" fill="#8f8677">No browser available for a screenshot — HTML text and images were extracted.</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function readAssetIndex(jobId: string): Promise<AssetIndexEntry[]> {
  try {
    return JSON.parse(await fs.readFile(jobFile(jobId, "assets-index.json"), "utf8"));
  } catch {
    return [];
  }
}
