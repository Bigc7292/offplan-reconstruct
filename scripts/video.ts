// Walkthrough video of a finished job: steps the app's guided tour (/tour/<id>) frame by frame in a
// headless browser and encodes the frames to exports/walkthrough.mp4 with ffmpeg.
//
//   npm run video -- <jobId> [--fps 25] [--size 1280x720] [--out file.mp4]   (app must be running)
//
// Also writes exports/walkthrough-poster.jpg and exports/walkthrough-contact.jpg (one frame per shot),
// which is what the critic agent looks at, since it cannot watch a video.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { launchBrowser } from "./lib/browser";
import sharp from "sharp";

const args = process.argv.slice(2);
const jobId = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!jobId) throw new Error("Usage: npm run video -- <jobId> [--fps 25] [--size 1280x720] [--out file.mp4]");
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const FPS = Number(opt("fps", "25"));
const [W, H] = opt("size", "1280x720").split("x").map(Number);
const BASE = process.env.APP_URL ?? "http://localhost:3000";
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data", "jobs");
const OUT = path.resolve(opt("out", path.join(DATA, jobId, "exports", "walkthrough.mp4")));

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return r.status === 0 ? "ffmpeg" : null;
}

const ffmpeg = ffmpegPath();
if (!ffmpeg) throw new Error("ffmpeg is not installed (apt install ffmpeg / brew install ffmpeg, or set FFMPEG_PATH).");
const frames = fs.mkdtempSync(path.join(os.tmpdir(), `walkthrough-${jobId}-`));
const { browser, gpu } = await launchBrowser();
console.log(`WebGL: ${gpu}`);
const t0 = Date.now();
let n = 0;
const shotFrames: Array<{ index: number; file: string }> = [];
try {
  const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/tour/${jobId}?capture=1`);
  await page.waitForFunction(() => !!(window as unknown as { __offplanTour?: unknown }).__offplanTour, null, { timeout: 120_000 });
  const duration = await page.evaluate(() => (window as unknown as { __offplanTour: { duration: number } }).__offplanTour.duration);
  const total = Math.ceil(duration * FPS);
  console.log(`Tour: ${duration.toFixed(1)} s → ${total} frames at ${FPS} fps, ${W}×${H}`);
  // let textures and the environment map finish loading before the first frame
  await page.evaluate(() => (window as unknown as { __offplanTour: { seek: (t: number) => void } }).__offplanTour.seek(0));
  await page.waitForTimeout(4000);
  let lastShot = -1;
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    // (the page does the waiting: code passed to evaluate must not define named functions under tsx)
    const state = await page.evaluate((sec) => (window as unknown as { __offplanTour: { step: (t: number) => Promise<{ index: number; caption: number }> } }).__offplanTour.step(sec), t);
    if (state.index !== lastShot) {
      // a new shot swaps which floors and ceilings are drawn: give React a moment to commit
      await page.waitForTimeout(250);
      lastShot = state.index;
    }
    const file = path.join(frames, `f${String(i).padStart(5, "0")}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 90 });
    n++;
    if (i % FPS === 0) process.stdout.write(`\r  frame ${i}/${total}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    // first fully captioned frame of each shot goes on the contact sheet
    if (state.caption > 0.95 && !shotFrames.some((s) => s.index === state.index)) shotFrames.push({ index: state.index, file });
  }
  process.stdout.write("\n");
  if (errors.length) console.log(`Browser errors:\n  ${errors.slice(0, 5).join("\n  ")}`);
} finally {
  await browser.close();
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const enc = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(frames, "f%05d.jpg"), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT], { stdio: "inherit" });
if (enc.status !== 0) throw new Error("ffmpeg failed");

// poster (first room shot, else the opening frame) and a contact sheet of one frame per shot
const picks = shotFrames;
const poster = picks[Math.min(2, picks.length - 1)]?.file ?? path.join(frames, "f00050.jpg");
if (fs.existsSync(poster)) await sharp(poster).jpeg({ quality: 88 }).toFile(OUT.replace(/\.mp4$/, "-poster.jpg"));
if (picks.length) {
  const cols = 4, tw = 480, th = Math.round((tw * H) / W);
  const rows = Math.ceil(picks.length / cols);
  const tiles = await Promise.all(picks.map(async (p, i) => ({
    input: await sharp(p.file).resize(tw, th).toBuffer(),
    left: (i % cols) * tw, top: Math.floor(i / cols) * th,
  })));
  await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: "#000" } }).composite(tiles).jpeg({ quality: 85 }).toFile(OUT.replace(/\.mp4$/, "-contact.jpg"));
}
fs.rmSync(frames, { recursive: true, force: true });
const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${OUT} (${mb} MB)`);
