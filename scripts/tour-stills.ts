// One still from the middle of every shot of the guided tour: a quick look at the walkthrough without
// recording the whole video (the critic agent can score these between full recordings).
//
//   npm run stills -- <jobId> [outDir]      (app must be running: npm run build && npm start)
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "./lib/browser";
import { buildTour } from "../src/lib/tour";
import type { PropertySceneGraph } from "../src/lib/schema";

const [jobId, outArg] = process.argv.slice(2);
if (!jobId) throw new Error("Usage: npm run stills -- <jobId> [outDir]");
const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = path.resolve(outArg ?? `data/screenshots/${jobId}/tour`);
fs.mkdirSync(OUT, { recursive: true });
const only = process.env.SHOTS?.split(",").map(Number);

type Tour = { duration: number; step: (t: number) => Promise<{ index: number }> };
const { browser, gpu } = await launchBrowser();
console.log(`WebGL: ${gpu}`);
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
page.on("pageerror", (e) => console.error(String(e)));
await page.goto(`${BASE}/tour/${jobId}?capture=1`);
await page.waitForFunction(() => !!(window as unknown as { __offplanTour?: unknown }).__offplanTour, null, { timeout: 120_000 });
const scene = JSON.parse(fs.readFileSync(path.resolve(`data/jobs/${jobId}/scene-graph.json`), "utf8")) as PropertySceneGraph;
const shots = buildTour(scene);
let acc = 0;
const mids = shots.map((s) => { const m = acc + s.duration * 0.6; acc += s.duration; return m; });
shots.forEach((s, i) => console.log(i, s.kind, s.title));
for (const [i, t] of mids.entries()) {
  if (only && !only.includes(i)) continue;
  await page.evaluate((sec) => (window as unknown as { __offplanTour: Tour }).__offplanTour.step(sec), t);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate((sec) => (window as unknown as { __offplanTour: Tour }).__offplanTour.step(sec), t);
  const file = path.join(OUT, `shot-${String(i).padStart(2, "0")}.png`);
  await page.screenshot({ path: file, timeout: 120_000 });
  console.log(file);
}
await browser.close();
