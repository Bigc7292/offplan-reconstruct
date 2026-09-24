// OCR via the tesseract binary when it is installed (apt install tesseract-ocr tesseract-ocr-ara).
// Scanned brochure pages have no text layer; without OCR their captions would be lost.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TextItem } from "./schema";

const run = promisify(execFile);
let available: { ok: boolean; langs: string[] } | null = null;

export async function ocrAvailable() {
  if (available) return available;
  try {
    const { stdout } = await run("tesseract", ["--list-langs"], { timeout: 10_000 });
    const langs = stdout.split("\n").slice(1).map((s) => s.trim()).filter(Boolean);
    available = { ok: true, langs };
  } catch {
    available = { ok: false, langs: [] };
  }
  return available;
}

export type OcrResult = { text: string; items: TextItem[]; meanConfidence: number };

/** OCR an image file. Returns line-level items with page-normalised bboxes. */
export async function ocrImage(file: string, width: number, height: number): Promise<OcrResult | null> {
  const av = await ocrAvailable();
  if (!av.ok) return null;
  const lang = ["eng", "ara"].filter((l) => av.langs.includes(l)).join("+") || "eng";
  const { stdout } = await run("tesseract", [file, "stdout", "-l", lang, "--psm", "3", "tsv"], { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  // TSV columns: level page_num block_num par_num line_num word_num left top width height conf text
  const lines = new Map<string, { words: string[]; x0: number; y0: number; x1: number; y1: number; conf: number[] }>();
  for (const row of stdout.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const conf = Number(c[10]);
    const word = c[11]?.trim();
    if (!word || conf < 45) continue;
    const key = `${c[2]}-${c[3]}-${c[4]}`;
    const [l, t, w, h] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
    const ln = lines.get(key) ?? { words: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, conf: [] };
    ln.words.push(word);
    ln.x0 = Math.min(ln.x0, l); ln.y0 = Math.min(ln.y0, t); ln.x1 = Math.max(ln.x1, l + w); ln.y1 = Math.max(ln.y1, t + h);
    ln.conf.push(conf);
    lines.set(key, ln);
  }
  const items: TextItem[] = [];
  const confs: number[] = [];
  for (const ln of lines.values()) {
    const str = ln.words.join(" ");
    // drop lines that are just OCR noise from textures (mostly punctuation)
    if (str.replace(/[^\p{L}\p{N}]/gu, "").length < 2) continue;
    items.push({ str, bbox: [ln.x0 / width, ln.y0 / height, ln.x1 / width, ln.y1 / height], size: (ln.y1 - ln.y0) / height });
    confs.push(...ln.conf);
  }
  items.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  return { text: items.map((i) => i.str).join("\n"), items, meanConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length / 100 : 0 };
}
