// Screenshots of a finished job in the running app, for review (the critic agent scores these).
//
//   npm run screenshots -- <jobId> [outDir]      (app must be running: npm run build && npm start)
//
// Captures the home page, the review page, the model in dollhouse view (all floors and each floor),
// walk views in the main rooms, the plan view and the share page.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { launchBrowser } from "./lib/browser";

const [jobId, outArg] = process.argv.slice(2);
if (!jobId) throw new Error("Usage: npm run screenshots -- <jobId> [outDir]");
const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = path.resolve(outArg ?? `data/screenshots/${jobId}`);
fs.mkdirSync(OUT, { recursive: true });


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shots: string[] = [];
async function shot(page: Page, name: string) {
  const file = path.join(OUT, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, timeout: 120_000 });
  shots.push(file);
  console.log(file);
}

const { browser, gpu } = await launchBrowser();
console.log(`WebGL: ${gpu}`);
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
try {
  await page.goto(BASE);
  await sleep(1500);
  await shot(page, "home");

  await page.goto(`${BASE}/jobs/${jobId}`);
  await page.getByTestId("dossier-table").waitFor({ timeout: 60_000 }).catch(() => {});
  await sleep(2500);
  await shot(page, "review");

  await page.goto(`${BASE}/jobs/${jobId}/model`);
  await page.getByTestId("viewer").waitFor();
  await sleep(6000);
  await shot(page, "dollhouse");
  const levels = await page.locator("[data-testid=level-chip]").allInnerTexts().catch(() => [] as string[]);
  for (const name of levels) {
    await page.locator("[data-testid=level-chip]", { hasText: name }).first().click();
    await sleep(3500);
    await shot(page, `dollhouse-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  }

  await page.getByTestId("mode-walk").click();
  await sleep(2500);
  const wanted = (process.env.WALK_ROOMS ?? "Family Lounge,Formal Lounge,Main Kitchen,Master Bedroom,Roof Lounge").split(",");
  for (const name of levels) {
    await page.locator("[data-testid=level-chip]", { hasText: name }).first().click();
    await sleep(1500);
    for (const room of wanted) {
      const btn = page.locator(`[data-room="${room}"]`).first();
      if (!(await btn.count())) continue;
      await btn.click();
      await sleep(3500);
      await shot(page, `walk-${room.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    }
  }

  await page.getByTestId("mode-plan").click();
  await sleep(3500);
  await shot(page, "plan");

  // the buyer's share page: the landing view, scrolled, then the interactive model behind it
  await page.goto(`${BASE}/view/${jobId}`);
  await page.getByTestId("key-facts").waitFor({ timeout: 60_000 }).catch(() => {});
  await sleep(2500);
  await shot(page, "share");
  await page.mouse.wheel(0, 900);
  await sleep(1200);
  await shot(page, "share-more");
  await page.mouse.wheel(0, 1400);
  await sleep(1200);
  await shot(page, "share-sources");
  await page.goto(`${BASE}/view/${jobId}?explore=1`);
  await page.getByTestId("viewer").waitFor();
  await sleep(6000);
  await shot(page, "share-explore");
  // rendered views (Blender), when the job has them
  if (await page.getByTestId("render-gallery").count()) {
    const thumbs = page.locator("[data-testid=render-gallery] button[title]");
    const n = await thumbs.count();
    for (let i = 1; i < n; i += Math.max(1, Math.floor(n / 4))) {
      // an open render covers the gallery: close it before picking the next one
      await page.keyboard.press("Escape").catch(() => {});
      await thumbs.nth(i).click({ force: true, timeout: 10_000 }).catch(() => {});
      await sleep(1500);
      await shot(page, `share-render-${i}`);
    }
  }
} finally {
  await browser.close();
}
if (errors.length) console.log(`Browser errors:\n  ${errors.slice(0, 5).join("\n  ")}`);
console.log(`${shots.length} screenshots in ${OUT}`);
