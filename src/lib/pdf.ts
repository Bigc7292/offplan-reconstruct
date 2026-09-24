// PDF ingest: rasterise every page (≈144 dpi, 2× for plan pages happens at crop time),
// keep the text layer with positions, OCR pages that have no text layer, and cut out
// every embedded image placement as its own asset (CGI, plans, photos).
import path from "node:path";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import type { PageRecord, TextItem } from "./schema";
import { jobFile, log, writeJobFile } from "./store";
import { ocrImage, ocrAvailable } from "./ocr";
import { dHash, imageStats } from "./image-stats";

// pdfjs is ESM-only; load lazily so Next's server bundle keeps it external.
async function pdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

export type RawRegion = { page: number; bbox: [number, number, number, number]; imgW: number; imgH: number };
export type IngestedAsset = { id: string; path: string; page: number; bbox: [number, number, number, number]; hash: string; w: number; h: number };

const MAX_PAGE_PX = 2600;

export const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export function detectLanguages(text: string): Array<"en" | "ar"> {
  const langs: Array<"en" | "ar"> = [];
  if (/[A-Za-z]{2,}/.test(text)) langs.push("en");
  if (ARABIC.test(text)) langs.push("ar");
  return langs;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

export async function ingestPdf(
  jobId: string, sourceId: string, data: Buffer, startN: number,
): Promise<{ pages: PageRecord[]; assets: IngestedAsset[]; meta: Record<string, string> }> {
  const { getDocument, OPS } = await pdfjs();
  const doc = await getDocument({ data: new Uint8Array(data), verbosity: 0, useSystemFonts: true }).promise;
  const md = await doc.getMetadata().catch(() => null);
  const info = (md?.info ?? {}) as Record<string, unknown>;
  const meta: Record<string, string> = {};
  for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate"]) if (typeof info[k] === "string" && info[k]) meta[k] = String(info[k]);
  const ocr = await ocrAvailable();
  if (!ocr.ok) await log(jobId, "ingest", "OCR binary (tesseract) not installed — scanned pages will have no text.", "warn");

  const pages: PageRecord[] = [];
  const assets: IngestedAsset[] = [];
  const seen: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const n = startN + i - 1;
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, MAX_PAGE_PX / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // @napi-rs/canvas implements the subset of CanvasRenderingContext2D pdfjs needs
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
    const png = canvas.toBuffer("image/png");
    const imgRel = `pages/${n}.png`;
    const thumbRel = `pages/${n}.thumb.jpg`;
    await writeJobFile(jobId, imgRel, png);
    await writeJobFile(jobId, thumbRel, await sharp(png).resize(360).jpeg({ quality: 78 }).toBuffer());

    // text layer, page-normalised boxes (origin top-left)
    const tc = await page.getTextContent();
    const [vx0, vy0, vx1, vy1] = page.view;
    const pw = vx1 - vx0, ph = vy1 - vy0;
    const items: TextItem[] = [];
    let text = "";
    let lastY: number | null = null;
    for (const it of tc.items as Array<{ str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }>) {
      if (!("str" in it)) continue;
      const tx = it.transform[4], ty = it.transform[5];
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height;
      if (lastY !== null && Math.abs(ty - lastY) > size * 0.5 && !text.endsWith("\n")) text += "\n";
      text += it.str;
      if (it.hasEOL) text += "\n";
      lastY = ty;
      if (!it.str.trim()) continue;
      items.push({
        str: it.str,
        bbox: [(tx - vx0) / pw, 1 - (ty - vy0 + size) / ph, (tx - vx0 + it.width) / pw, 1 - (ty - vy0) / ph],
        size: size / ph,
      });
    }
    let textSource: PageRecord["textSource"] = items.length ? "text_layer" : "none";
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.replace(/\s/g, "").length < 12 && ocr.ok) {
      const res = await ocrImage(jobFile(jobId, imgRel), canvas.width, canvas.height);
      if (res && res.items.length) {
        items.splice(0, items.length, ...res.items);
        text = res.text;
        textSource = "ocr";
        await log(jobId, "ingest", `Page ${n}: no text layer — OCR read ${res.items.length} line(s) (mean confidence ${(res.meanConfidence * 100).toFixed(0)}%).`);
      }
    }
    await writeJobFile(jobId, `pages/${n}.txt`, text);

    // embedded image placements → crops
    const ol = await page.getOperatorList();
    let ctm: M = [1, 0, 0, 1, 0, 0];
    const stack: M[] = [];
    const regions: RawRegion[] = [];
    for (let k = 0; k < ol.fnArray.length; k++) {
      const fn = ol.fnArray[k];
      const args = ol.argsArray[k];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args as M);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0] as M); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
        const xs = pts.map((p) => (p[0] - vx0) / pw), ys = pts.map((p) => 1 - (p[1] - vy0) / ph);
        // decorative backgrounds are placed mostly off-page and clipped; they are not content
        const ux0 = Math.min(...xs), ux1 = Math.max(...xs), uy0 = Math.min(...ys), uy1 = Math.max(...ys);
        const full = (ux1 - ux0) * (uy1 - uy0);
        const inside = Math.max(0, Math.min(1, ux1) - Math.max(0, ux0)) * Math.max(0, Math.min(1, uy1) - Math.max(0, uy0));
        if (full <= 0 || inside / full < 0.85) continue;
        const bb: [number, number, number, number] = [
          Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(1, Math.max(...xs)), Math.min(1, Math.max(...ys)),
        ];
        const w = typeof args?.[1] === "number" ? args[1] : 0, h = typeof args?.[2] === "number" ? args[2] : 0;
        regions.push({ page: n, bbox: bb, imgW: w, imgH: h });
      }
    }
    // a large image painted underneath later images is a backdrop/frame (Canva-style layouts), not content
    const areaOf = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const overlap = (a: number[], b: number[]) => areaOf([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
    const backdrops = new Set(regions.filter((r, i) => regions.slice(i + 1).some((q) => areaOf(r.bbox) > areaOf(q.bbox) * 1.1 && overlap(r.bbox, q.bbox) / Math.max(1e-6, areaOf(q.bbox)) > 0.3)));
    for (const r of regions) {
      if (backdrops.has(r)) continue;
      const area = (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]);
      if (area < 0.02 || area > 0.93) continue; // skip icons/logos-in-corners and full-page backgrounds
      const left = Math.round(r.bbox[0] * canvas.width), top = Math.round(r.bbox[1] * canvas.height);
      const width = Math.round((r.bbox[2] - r.bbox[0]) * canvas.width), height = Math.round((r.bbox[3] - r.bbox[1]) * canvas.height);
      if (width < 40 || height < 40) continue;
      const crop = await sharp(png).extract({ left, top, width, height }).png().toBuffer();
      const hash = await dHash(crop);
      const { hamming } = await import("./image-stats");
      if (seen.some((h) => hamming(h, hash) <= 3)) continue; // perceptual duplicate
      seen.push(hash);
      const id = `a${n}-${hash.slice(0, 8)}`;
      const rel = `assets/${id}.png`;
      await writeJobFile(jobId, rel, crop);
      assets.push({ id, path: rel, page: n, bbox: r.bbox, hash, w: width, h: height });
    }

    const stats = await imageStats(png);
    pages.push({
      n, sourceId, sourcePage: i, image: imgRel, thumb: thumbRel, widthPx: canvas.width, heightPx: canvas.height,
      text, textSource, items, languages: detectLanguages(text), labels: [], labelConfidence: 0, labelReason: "", stats,
    });
    await log(jobId, "ingest", `Page ${n} (${path.basename(sourceId)} p${i}): ${canvas.width}×${canvas.height}px, ${textSource === "none" ? "no text" : `${items.length} text item(s) via ${textSource}`}, ${regions.length} image placement(s).`);
    page.cleanup();
  }
  await doc.destroy();
  return { pages, assets, meta };
}
