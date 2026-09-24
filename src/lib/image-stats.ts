// Cheap image signals used by the local classifier and material pass.
import sharp from "sharp";

export type ImageStats = { whiteRatio: number; saturation: number; edgeDensity: number; colorStd: number };

/** Whiteness, saturation, edge density and colour spread on a 128px downsample. */
export async function imageStats(input: Buffer | string, region?: { left: number; top: number; width: number; height: number }): Promise<ImageStats> {
  let img = sharp(input);
  if (region) img = img.extract(region);
  const { data, info } = await img.resize(128, 128, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let white = 0, satSum = 0, edges = 0;
  const lum = new Float32Array(n);
  let rS = 0, gS = 0, bS = 0, rQ = 0, gQ = 0, bQ = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = L;
    if (L > 225 && sat < 0.12) white++;
    satSum += sat;
    rS += r; gS += g; bS += b; rQ += r * r; gQ += g * g; bQ += b * b;
  }
  for (let y = 1; y < info.height - 1; y++)
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      const gx = lum[i + 1] - lum[i - 1], gy = lum[i + info.width] - lum[i - info.width];
      if (Math.hypot(gx, gy) > 60) edges++;
    }
  const std = (s: number, q: number) => Math.sqrt(Math.max(0, q / n - (s / n) ** 2));
  return {
    whiteRatio: white / n,
    saturation: satSum / n,
    edgeDensity: edges / n,
    colorStd: (std(rS, rQ) + std(gS, gQ) + std(bS, bQ)) / 3,
  };
}

/** 64-bit difference hash, as a 16-char hex string. */
export async function dHash(input: Buffer | string): Promise<string> {
  const { data } = await sharp(input).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

export function hamming(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b), c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

/** Mean colour of a region given in 0-1 image fractions. */
export async function regionColor(input: Buffer | string, fr: { x0: number; y0: number; x1: number; y1: number }): Promise<string> {
  const meta = await sharp(input).metadata();
  const W = meta.width!, H = meta.height!;
  const left = Math.max(0, Math.round(fr.x0 * W)), top = Math.max(0, Math.round(fr.y0 * H));
  const width = Math.max(1, Math.min(W - left, Math.round((fr.x1 - fr.x0) * W)));
  const height = Math.max(1, Math.min(H - top, Math.round((fr.y1 - fr.y0) * H)));
  const crop = await sharp(input).extract({ left, top, width, height }).removeAlpha().png().toBuffer();
  const { channels } = await sharp(crop).stats();
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(channels[0].mean)}${hex(channels[1].mean)}${hex(channels[2].mean)}`;
}

/** Dominant colours by k-means on a 48px downsample. Sorted by share, deterministic. */
export async function dominantColors(input: Buffer | string, k = 5): Promise<Array<{ hex: string; share: number }>> {
  const { data } = await sharp(input).resize(48, 48, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px: number[][] = [];
  for (let i = 0; i < data.length; i += 3) px.push([data[i], data[i + 1], data[i + 2]]);
  // deterministic init: evenly spaced by luminance
  const sorted = [...px].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let cents = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)].slice());
  let assign = new Array(px.length).fill(0);
  for (let it = 0; it < 12; it++) {
    assign = px.map((p) => {
      let best = 0, bd = Infinity;
      cents.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } });
      return best;
    });
    cents = cents.map((c, j) => {
      const m = px.filter((_, i) => assign[i] === j);
      if (!m.length) return c;
      return [0, 1, 2].map((ch) => m.reduce((s, p) => s + p[ch], 0) / m.length);
    });
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return cents
    .map((c, j) => ({ hex: `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`, share: assign.filter((a) => a === j).length / px.length }))
    .sort((a, b) => b.share - a.share);
}

/**
 * Largest photographic block on a scanned page (a render beside white margins and a small key plan).
 * Returns a page-normalised bbox, or null when no clear block exists.
 */
export async function findPhotoRegion(input: Buffer | string): Promise<[number, number, number, number] | null> {
  const W = 256;
  const { data, info } = await sharp(input).resize(W, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const photo = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    photo[i] = L > 228 && (mx - mn) < 18 ? 0 : 1;
  }
  const longestRun = (vals: number[], thr: number) => {
    let best: [number, number] = [0, -1], s = -1;
    vals.forEach((v, i) => {
      if (v >= thr) { if (s < 0) s = i; if (i - s > best[1] - best[0]) best = [s, i]; }
      else s = -1;
    });
    return best;
  };
  // columns first (renders sit side-by-side with key plans), then rows inside those columns
  const colFrac = Array.from({ length: W }, (_, x) => { let c = 0; for (let y = 0; y < H; y++) c += photo[y * W + x]; return c / H; });
  const [x0, x1] = longestRun(colFrac, 0.3);
  if (x1 - x0 < W * 0.2) return null;
  const rowFrac = Array.from({ length: H }, (_, y) => { let c = 0; for (let x = x0; x <= x1; x++) c += photo[y * W + x]; return c / (x1 - x0 + 1); });
  const [y0, y1] = longestRun(rowFrac, 0.6);
  if (y1 - y0 < H * 0.15) return null;
  return [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H];
}
