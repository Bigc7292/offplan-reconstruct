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
    // paper is near pure white; a render's brightest areas (sunlit curtains, white walls) are still toned
    photo[i] = L > 244 && (mx - mn) < 12 ? 0 : 1;
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

/**
 * Largest line drawing on a scanned page outside `exclude` (the render): the key plan printed beside a render.
 * Returns a page-normalised bbox, or null when there is no drawing big enough to be a plan.
 */
export async function findDrawingRegion(input: Buffer | string, exclude?: [number, number, number, number]): Promise<[number, number, number, number] | null> {
  const W = 320;
  const { data, info } = await sharp(input).resize(W, null).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const ink = new Uint8Array(W * H);
  const tone = new Uint8Array(W * H); // anything but paper white: renders are toned edge to edge, plans are white between lines
  const [ex0, ey0, ex1, ey1] = exclude ? [exclude[0] * W - 3, exclude[1] * H - 3, exclude[2] * W + 3, exclude[3] * H + 3] : [0, 0, -1, -1];
  // the caption line under the render belongs to the render, not to a drawing
  const capY1 = ey1 + H * 0.06;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= ex0 && x <= ex1 && y >= ey0 && y <= capY1) continue;
      const i = y * W + x, r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (L < 225 || Math.max(r, g, b) - Math.min(r, g, b) > 30) ink[i] = 1;
      if (L < 246 || Math.max(r, g, b) - Math.min(r, g, b) > 12) tone[i] = 1;
    }
  }
  // join the lines of one drawing: dilate, then take connected blobs
  const R = 4;
  const grown = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!ink[y * W + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H) grown[Y * W + X] = 1;
    }
  }
  const seen = new Uint8Array(W * H);
  let best: { bb: [number, number, number, number]; score: number } | null = null;
  for (let s = 0; s < W * H; s++) {
    if (!grown[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0, inkN = 0;
    while (stack.length) {
      const i = stack.pop()!, x = i % W, y = (i - x) / W;
      n++;
      if (ink[i]) inkN++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= W * H || seen[j] || !grown[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    // a strip of the render the photo finder missed is dense from top to bottom: trim it off either side
    const dense = (x: number) => { let c = 0; for (let y = y0; y <= y1; y++) c += tone[y * W + x]; return c / (y1 - y0 + 1) > 0.6; };
    const blank = (x: number) => { for (let y = y0; y <= y1; y++) if (ink[y * W + x]) return false; return true; };
    if (dense(x0)) { while (x0 < x1 && dense(x0)) x0++; while (x0 < x1 && blank(x0)) x0++; }
    if (dense(x1)) { while (x1 > x0 && dense(x1)) x1--; while (x1 > x0 && blank(x1)) x1--; }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // a plan is a sizeable block with sparse ink (lines on white); logos and captions are small or flat
    if (w < W * 0.08 || h < H * 0.12) continue;
    const density = inkN / (w * h);
    if (density > 0.6) continue;
    const score = w * h;
    if (!best || score > best.score) best = { bb: [Math.max(0, x0 - 2) / W, Math.max(0, y0 - 2) / H, Math.min(W, x1 + 3) / W, Math.min(H, y1 + 3) / H], score };
  }
  return best?.bb ?? null;
}
