// End-to-end acceptance run against a running server (npm run build && npm start).
//
//   BASE_URL=http://localhost:3000 PDF=/path/brochure.pdf npm test
//
// A: DEMO unit in a real browser: generate, edit a wall length and watch the model change,
//    walk living → kitchen → master, click the kitchen floor for its evidence, export GLB,
//    reload and check the model is identical.
// B: brochure PDF + listing URL through the API: every page classified, room schedule with
//    areas and evidence. The URL fixture is served locally, so start the app with
//    ALLOW_PRIVATE_URLS=1 for part B.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.OUT_DIR ?? path.resolve("data/acceptance");
const PDF = process.env.PDF;
fs.mkdirSync(OUT, { recursive: true });

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function check(step: string, ok: boolean, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api<T = any>(p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + p, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → ${res.status} ${await res.text()}`);
  return (res.headers.get("content-type") ?? "").includes("json") ? res.json() : (res.arrayBuffer() as any);
}
async function waitForReview(id: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await api(`/api/jobs/${id}`);
    if (j.job.status === "error") throw new Error(`job failed: ${j.job.stages.find((s: any) => s.error)?.error}`);
    if (j.job.stages.find((s: any) => s.name === "review")?.status === "waiting" || j.job.status === "ready") return j;
    await sleep(1000);
  }
  throw new Error("timed out waiting for review");
}
function chromePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = "/opt/pw-browsers";
  const d = fs.existsSync(root) ? fs.readdirSync(root).find((x) => /^chromium-\d+$/.test(x)) : undefined;
  return d ? `${root}/${d}/chrome-linux/chrome` : undefined;
}

async function clickWorld(page: Page, x: number, y: number, z: number) {
  const p = await page.evaluate(([a, b, c]) => (window as any).__offplanProject?.(a, b, c), [x, y, z]);
  if (!p) throw new Error("viewer probe not ready");
  await page.mouse.click(p.x, p.y);
}

async function partA(page: Page) {
  const { id } = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ demo: true }) }).then((r: any) => r.job ?? r);
  await waitForReview(id);
  await page.goto(`${BASE}/jobs/${id}`);
  await page.getByTestId("generate").click();
  await page.getByTestId("preview-3d").locator("canvas").waitFor({ timeout: 60_000 });
  await sleep(2500);
  await page.getByTestId("preview-3d").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/a1-review.png`, timeout: 90_000 });
  const g1 = await api(`/api/jobs/${id}/scene`);
  check("A1 demo model generated", g1.stats.rooms > 5 && g1.stats.walls > 10, `${g1.stats.rooms} rooms, ${g1.stats.walls} walls, hash ${g1.dossierHash}`);

  // A2 edit a wall length in the table → dossier saved → model rebuilt with new geometry
  await page.getByRole("button", { name: /^Walls \d/ }).click();
  const input = page.getByTestId("wall-length").first();
  const before = Number(await input.inputValue());
  await input.fill((before + 0.5).toFixed(2));
  await input.press("Enter");
  let g2 = g1;
  for (let i = 0; i < 20 && g2.dossierHash === g1.dossierHash; i++) { await sleep(500); g2 = await api(`/api/jobs/${id}/scene`); }
  const b1 = g1.bounds, b2 = g2.bounds;
  const grew = Math.abs((b2.max.x - b2.min.x) - (b1.max.x - b1.min.x)) + Math.abs((b2.max.z - b2.min.z) - (b1.max.z - b1.min.z));
  check("A2 wall length edit updates the 3D model", g2.dossierHash !== g1.dossierHash, `wall ${before.toFixed(2)} → ${(before + 0.5).toFixed(2)} m; hash ${g1.dossierHash} → ${g2.dossierHash}; bounds changed by ${grew.toFixed(2)} m`);
  await sleep(1500);
  await page.getByTestId("preview-3d").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/a2-after-edit.png`, timeout: 90_000 });
  // put it back so the walkthrough uses the documented plan
  await input.fill(before.toFixed(2));
  await input.press("Enter");
  await sleep(2500);

  // A3 walk: living → kitchen → master via room jump, plus WASD movement with collisions
  await page.goto(`${BASE}/jobs/${id}/model`);
  await page.getByTestId("viewer").locator("canvas").waitFor({ timeout: 60_000 });
  await sleep(2000);
  await page.getByTestId("mode-walk").click();
  await sleep(1500);
  // Start in the living room, then walk with W only, turning toward each waypoint (what a
  // visitor does with the mouse). Walls and furniture collide, so the route has to use the
  // real openings: open-plan kitchen, corridor, walk-in wardrobe door, master opening.
  await page.locator(`[data-testid=room-list] [data-room="Living / Dining"]`).click();
  await sleep(1200);
  const roomNow = async () => (await page.getByTestId("walk-room").textContent())?.trim() ?? "";
  // the first walk frames compile shaders; give the room readout time to catch up
  const roomSoon = async (want: string) => { for (let i = 0; i < 40 && (await roomNow()) !== want; i++) await sleep(250); return roomNow(); };
  const visited = [await roomSoon("Living / Dining")];
  const route: Array<[number, number, string?]> = [[2.7, 4.2], [2.7, 5.3, "Kitchen"], [4.2, 5.4], [9.1, 5.4], [10.3, 5.4], [10.35, 4.3], [10.2, 3.4, "Master Bedroom"]];
  let stuck = "";
  for (const [x, y, label] of route) {
    let t0 = Date.now(), best = Infinity;
    await page.keyboard.down("KeyW");
    for (;;) {
      await page.evaluate(([a, b]) => (window as any).__offplanWalk.face(a, b), [x, y]);
      const p = await page.evaluate(() => (window as any).__offplanWalk.pose());
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 0.4) break; // software WebGL runs at a few fps, so steps are coarse
      if (d < best - 0.05) { best = d; t0 = Date.now(); }
      if (Date.now() - t0 > 8_000) { stuck = `stuck at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) heading for (${x}, ${y})`; break; }
      await sleep(40);
    }
    await page.keyboard.up("KeyW");
    if (stuck) break;
    if (label) {
      visited.push(await roomSoon(label));
      await page.screenshot({ path: `${OUT}/a3-walk-${label.split(" ")[0].toLowerCase()}.png`, timeout: 90_000 });
    }
  }
  check("A3 walk living → kitchen → master (WASD, with collisions)", !stuck && visited.join(",") === "Living / Dining,Kitchen,Master Bedroom", stuck || visited.join(" → "));
  // walls stop you: walk straight at the east wall of the master bedroom and stay inside
  await page.keyboard.down("KeyW");
  for (let i = 0; i < 120; i++) { await page.evaluate(() => (window as any).__offplanWalk.face(20, 3.4)); await sleep(50); }
  await page.keyboard.up("KeyW");
  const pe = await page.evaluate(() => (window as any).__offplanWalk.pose());
  check("A3b walls collide", pe.x < 13.4 - 0.1 - 0.2 && (await roomNow()) === "Master Bedroom", `pressed into the east wall (x=13.4): stopped at x=${pe.x.toFixed(2)}`);
  const g = await api(`/api/jobs/${id}/scene`);
  void g;

  // A4 click the kitchen floor in plan view → evidence drawer names the justification
  await page.getByTestId("mode-plan").click();
  await sleep(1500);
  const kitchen = g2.rooms.find((r: any) => r.name === "Kitchen");
  // open floor in the kitchen's north-east corner, clear of the counter run, island and label
  const xs = kitchen.polygon.map((p: any) => p.x), ys = kitchen.polygon.map((p: any) => p.y);
  const fx = Math.min(...xs) + 0.85 * (Math.max(...xs) - Math.min(...xs)), fy = Math.min(...ys) + 0.85 * (Math.max(...ys) - Math.min(...ys));
  await clickWorld(page, fx, kitchen.centroid.y + 0.01, -fy);
  await sleep(800);
  const drawer = page.getByTestId("evidence-drawer");
  const text = (await drawer.textContent().catch(() => "")) ?? "";
  await page.screenshot({ path: `${OUT}/a4-kitchen-evidence.png` });
  check("A4 kitchen floor shows its evidence", /Kitchen/.test(text) && /floor/.test(text) && /(page-|DEMO|p\d)/.test(text), text.replace(/\s+/g, " ").slice(0, 160));

  // A5 GLB export, validated with the Khronos validator
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByTestId("export-glb").click()]);
  const glbPath = `${OUT}/demo.glb`;
  await dl.saveAs(glbPath);
  const glb = fs.readFileSync(glbPath);
  let report = "validator not installed";
  let ok = glb.readUInt32LE(0) === 0x46546c67;
  try {
    const validator = await import("gltf-validator");
    const r = await (validator as any).validateBytes(new Uint8Array(glb));
    report = `${r.issues.numErrors} errors, ${r.issues.numWarnings} warnings`;
    ok = ok && r.issues.numErrors === 0;
  } catch { /* optional */ }
  check("A5 GLB export", ok, `${(glb.length / 1024).toFixed(0)} KB, ${report}`);

  // A6 reload gives the same model
  const s1 = JSON.stringify(await api(`/api/jobs/${id}/scene`));
  await page.reload();
  await page.getByTestId("viewer").locator("canvas").waitFor({ timeout: 60_000 });
  const s2 = JSON.stringify(await api(`/api/jobs/${id}/scene`));
  const s3 = JSON.stringify(await api(`/api/jobs/${id}/reconstruct`, { method: "POST" }));
  check("A6 reload and rebuild give the identical scene graph", s1 === s2 && s2 === s3, `${s1.length} bytes, hash ${JSON.parse(s1).dossierHash}`);
  const share = await page.goto(`${BASE}/view/${id}`);
  await page.getByTestId("viewer").locator("canvas").waitFor({ timeout: 60_000 });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/a7-share.png` });
  check("A7 share page renders", share?.ok() ?? false, `/view/${id}`);
  return id;
}

async function partB(page: Page) {
  if (!PDF || !fs.existsSync(PDF)) { console.log("SKIP  B (set PDF=/path/to/brochure.pdf)"); return; }
  // local listing page that links the brochure, standing in for a public listing URL
  const pdfBytes = fs.readFileSync(PDF);
  const server = http.createServer((req, res) => {
    if (req.url === "/brochure.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(pdfBytes); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Fixture listing</title><meta property="og:title" content="Fixture listing: sample villa"><meta name="description" content="Listing page fixture for the acceptance test."></head>
      <body><h1>Sample villa listing</h1><p>Handover Q4 2027. Built-up area 1,580 m² (17,012 sq ft). Price on request.</p><a href="/brochure.pdf">Download brochure</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/listing`;
  try {
    const fd = new FormData();
    fd.append("files", new Blob([pdfBytes], { type: "application/pdf" }), path.basename(PDF));
    fd.append("urls", url);
    const created: any = await api("/api/jobs", { method: "POST", body: fd });
    const id = created.job?.id ?? created.id;
    const t0 = Date.now();
    const j = await waitForReview(id, Number(process.env.REVIEW_TIMEOUT_MS ?? 600_000));
    const pdfPages = j.job.pages.filter((p: any) => j.job.sources.find((s: any) => s.id === p.sourceId)?.kind === "pdf");
    const unclassified = j.job.pages.filter((p: any) => !p.labels.length);
    check("B1 PDF + URL ingested", j.job.sources.length >= 2 && pdfPages.length > 1, `${j.job.sources.map((s: any) => `${s.kind}:${s.status}`).join(", ")}; ${j.job.pages.length} pages in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    check("B2 every page classified", unclassified.length === 0, j.job.pages.map((p: any) => `p${p.n}:${p.labels.join("+")}`).join(" "));
    const rooms = j.dossier.levels.flatMap((l: any) => l.rooms.map((r: any) => ({ ...r, level: l.name })));
    const withArea = rooms.filter((r: any) => r.areaM2 || r.polygon.length >= 3);
    const withEv = rooms.filter((r: any) => r.evidence.some((e: any) => /^page-\d+$/.test(e.ref)));
    check("B3 room schedule with evidence", rooms.length > 0 && withEv.length === rooms.length, `${rooms.length} rooms on ${j.dossier.levels.length} levels, ${withEv.length} with page evidence, ${withArea.length} with an area`);
    const facts = j.dossier.facts.map((f: any) => `${f.key}=${f.value}`);
    check("B4 key facts extracted", facts.length > 3, facts.slice(0, 8).join("; "));
    await page.goto(`${BASE}/jobs/${id}`);
    await page.getByTestId("dossier-table").waitFor();
    await sleep(2000);
    await page.screenshot({ path: `${OUT}/b-review.png`, timeout: 90_000 });
    return id;
  } finally {
    server.close();
  }
}

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
// web fonts come from Google Fonts; offline sandboxes can't reach them and fall back to system fonts
page.on("console", (m) => { if (m.type() === "error" && !/ERR_TOO_MANY_RETRIES|ERR_CERT|fonts\.g/.test(m.text())) errors.push(m.text()); });
let demoId = "", pdfId: string | undefined;
try {
  demoId = await partA(page);
  pdfId = await partB(page);
} catch (e) {
  check("run completed", false, String(e));
  await page.screenshot({ path: `${OUT}/failure.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
check("no browser errors", errors.length === 0, errors.slice(0, 5).join(" | "));
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, demoId, pdfId, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots and results in ${OUT}`);
process.exit(failed ? 1 : 0);
