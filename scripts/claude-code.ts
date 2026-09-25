// Read a brochure with Claude Code instead of a paid model API.
//
//   npm run cc -- new <brochure.pdf> [more files or URLs] [--unit "Villa 8"]
//       creates a job, renders and reads every page locally, and writes one request per
//       vision task (page classification, facts, each floor plan, each render) to
//       data/jobs/{id}/claude-code/{task}/
//   npm run cc -- status <jobId>      lists requests still waiting for an answer
//   npm run cc -- next <jobId>        re-runs classification and extraction with the answers written so far;
//                                     new requests can appear (e.g. a page newly recognised as a plan)
//   npm run cc -- check <jobId>       validates the answers written so far against their schemas
//   npm run cc -- build <jobId>       builds the 3D model and GLB, and prints the links to open
//   npm run cc -- sketch <request folder>
//                                     turns plan-sketch.json (room outlines, doors, windows in image pixels) into
//                                     answer.json with walls derived from the rooms, and draws sketch-overlay.png
//   npm run cc -- zoom <image> [x0 y0 x1 y1] [out.png]
//                                     enlarges a region with a pixel grid in the image's own coordinates,
//                                     for reading small print and tracing plans
//
// Claude Code answers a request by reading request.md, looking at the image files and writing
// answer.json (validated against schema.json). The skill in .claude/skills/read-brochure runs the whole loop.
import fs from "node:fs/promises";
import path from "node:path";

process.env.LLM_PROVIDER = "claude-code";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags.set(rest[i].slice(2), rest[i + 1] ?? ""), i++;
  else args.push(rest[i]);
}

const store = await import("../src/lib/store");
const { HANDOFF_DIR } = await import("../src/lib/llm");
const APP = process.env.APP_URL ?? "http://localhost:3000";

type Req = { key: string; dir: string; answered: boolean; error?: string; current: boolean };

async function requests(id: string, since?: number): Promise<Req[]> {
  const root = store.jobFile(id, HANDOFF_DIR);
  const keys = await fs.readdir(root).catch(() => [] as string[]);
  const out: Req[] = [];
  for (const key of keys.sort()) {
    const dir = path.join(root, key);
    const st = await fs.stat(path.join(dir, "request.json")).catch(() => null);
    if (!st) continue;
    const answered = await fs.stat(path.join(dir, "answer.json")).then(() => true, () => false);
    const error = await fs.readFile(path.join(dir, "answer-error.txt"), "utf8").catch(() => undefined);
    out.push({ key, dir, answered, error, current: since === undefined || st.mtimeMs >= since - 1000 });
  }
  return out;
}

async function report(id: string, since?: number) {
  const all = (await requests(id, since)).filter((r) => r.current);
  const waiting = all.filter((r) => !r.answered || r.error);
  const job = await store.readJob(id);
  console.log(`\nJob ${id} · ${job?.title} · ${job?.pages.length ?? 0} page(s)`);
  console.log(`Requests: ${all.length - waiting.length} answered, ${waiting.length} waiting.`);
  for (const r of waiting) console.log(`  ${r.error ? "FIX " : "TODO"}  ${path.relative(process.cwd(), r.dir)}/request.md${r.error ? `\n        ${r.error.split("\n").join("\n        ")}` : ""}`);
  if (!waiting.length) console.log(`All requests answered. Next: npm run cc -- build ${id}`);
  else console.log(`Answer each one with answer.json in its folder, then: npm run cc -- next ${id}`);
  return waiting.length;
}

async function mustJob(id?: string) {
  if (!id) throw new Error("Give the job id (the folder name under data/jobs).");
  const j = await store.readJob(id);
  if (!j) throw new Error(`No job ${id} in ${store.DATA_DIR}.`);
  return j;
}

if (cmd === "new") {
  if (!args.length) throw new Error("Usage: npm run cc -- new <brochure.pdf> [more.pdf|https://listing] [--unit \"Villa 8\"]");
  const { createJob, setStage, log } = store;
  const { registerSources } = await import("../src/lib/ingest");
  const { runToReview } = await import("../src/lib/pipeline");
  const files = [] as Array<{ name: string; type: string; data: Buffer }>;
  const urls = [] as string[];
  for (const a of args) {
    if (/^https?:\/\//.test(a)) { urls.push(a); continue; }
    const ext = path.extname(a).toLowerCase();
    files.push({ name: path.basename(a), type: ext === ".pdf" ? "application/pdf" : ext === ".png" ? "image/png" : "image/jpeg", data: await fs.readFile(a) });
  }
  const title = files[0]?.name.replace(/\.[a-z0-9]+$/i, "") ?? new URL(urls[0]).hostname;
  const job = await createJob({ title, unitFocus: flags.get("unit") || undefined, notes: flags.get("notes") || undefined, extractor: "claude-code", extractorLabel: "Claude Code (no API key)" });
  await setStage(job.id, "create", "running");
  await registerSources(job.id, { files, urls });
  await setStage(job.id, "create", "done");
  await log(job.id, "create", `Job created from Claude Code with ${files.length} file(s) and ${urls.length} URL(s).`);
  const t0 = Date.now();
  console.log(`Reading ${args.length} source(s) locally…`);
  await runToReview(job.id);
  await report(job.id, t0);
} else if (cmd === "status") {
  const j = await mustJob(args[0]);
  await report(j.id);
} else if (cmd === "next") {
  const j = await mustJob(args[0]);
  const { runToReview } = await import("../src/lib/pipeline");
  const t0 = Date.now();
  await runToReview(j.id, "classify");
  const after = await store.readJob(j.id);
  if (after?.status === "error") throw new Error(`Pipeline failed; see ${store.jobFile(j.id, "logs.jsonl")}`);
  await report(j.id, t0);
} else if (cmd === "build") {
  const j = await mustJob(args[0]);
  const { runReconstruct, runExport } = await import("../src/lib/pipeline");
  const g = await runReconstruct(j.id);
  await runExport(j.id);
  // the model is built: the job is ready, and it goes by the property's name rather than the file's
  await store.updateJob(j.id, (x) => { x.status = "ready"; if (g.title) x.title = g.title; });
  console.log(`Built ${g.stats.rooms} rooms, ${g.stats.walls} walls, ${g.stats.openings} openings on ${g.levels.length} level(s).`);
  for (const w of g.warnings) console.log(`  note: ${w}`);
  console.log(`\nReview:  ${APP}/jobs/${j.id}\nWalk:    ${APP}/jobs/${j.id}/model\nShare:   ${APP}/view/${j.id}\nGLB:     ${store.jobFile(j.id, "exports/model.glb")}`);
} else if (cmd === "check") {
  // validate answers without re-running the pipeline (safe to run while other answers are being written)
  const j = await mustJob(args[0]);
  const llm = await import("../src/lib/llm");
  const { FindPlansSchema } = await import("../src/lib/find-plans");
  const schemas: Record<string, import("zod/v4").ZodType> = { PageClassification: llm.ClassifySchema, Facts: llm.FactsSchema, Level: llm.PlanLevelSchema, KeyPlan: llm.KeyPlanSchema, "Material[]": llm.CgiSchema, FindPlans: FindPlansSchema };
  let bad = 0, ok = 0, todo = 0;
  for (const r of await requests(j.id)) {
    const req = JSON.parse(await fs.readFile(path.join(r.dir, "request.json"), "utf8"));
    const raw = await fs.readFile(path.join(r.dir, "answer.json"), "utf8").catch(() => null);
    if (raw === null) { todo++; continue; }
    let json: unknown;
    try { json = JSON.parse(raw); } catch (e) { bad++; console.log(`BAD  ${r.key}: not JSON (${e})`); continue; }
    const res = schemas[req.schemaName]?.safeParse(json);
    if (res && !res.success) { bad++; console.log(`BAD  ${r.key}: ${res.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`); }
    else ok++;
  }
  console.log(`${ok} valid, ${bad} invalid, ${todo} not answered yet.`);
  if (bad) process.exitCode = 1;
} else if (cmd === "sketch") {
  // plan-sketch.json (rooms + openings in image pixels) → answer.json, plus sketch-overlay.png to check it by eye
  const dir = path.resolve(args[0] ?? ".");
  const { sketchToPlan } = await import("../src/lib/plan-sketch");
  const req = JSON.parse(await fs.readFile(path.join(dir, "request.json"), "utf8"));
  const img = req.images[0];
  const sketch = JSON.parse(await fs.readFile(path.join(dir, "plan-sketch.json"), "utf8"));
  const out = sketchToPlan(sketch, img.w, img.h);
  const llm = await import("../src/lib/llm");
  (req.schemaName === "KeyPlan" ? llm.KeyPlanSchema : llm.PlanLevelSchema).parse({ cameras: [], ...out });
  await fs.writeFile(path.join(dir, "answer.json"), JSON.stringify(req.schemaName === "KeyPlan" ? { cameras: [], ...out } : out, null, 2));
  const colour = { exterior: "#d11", interior: "#06c", glass: "#0bb", railing: "#a0a", partition: "#888" } as Record<string, string>;
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${img.w}" height="${img.h}">`,
    ...out.rooms.map((r) => `<polygon points="${r.polygon.map((p) => `${p.x},${p.y}`).join(" ")}" fill="rgba(255,200,0,0.18)" stroke="none"/>`),
    ...out.walls.map((w) => `<line x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}" stroke="${colour[w.kind]}" stroke-width="3" opacity="0.8"/>`),
    ...out.walls.flatMap((w) => w.openings.map((o) => {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), ux = (w.b.x - w.a.x) / L, uy = (w.b.y - w.a.y) / L;
      const cx = w.a.x + ux * o.offset * L, cy = w.a.y + uy * o.offset * L, h = o.width / 2;
      return `<line x1="${cx - ux * h}" y1="${cy - uy * h}" x2="${cx + ux * h}" y2="${cy + uy * h}" stroke="${o.kind === "window" ? "#0d0" : "#fa0"}" stroke-width="6"/>`;
    })),
    ...out.rooms.map((r) => {
      const cx = r.polygon.reduce((a, p) => a + p.x, 0) / r.polygon.length, cy = r.polygon.reduce((a, p) => a + p.y, 0) / r.polygon.length;
      return `<text x="${cx}" y="${cy}" font-size="10" font-family="sans-serif" fill="#000" text-anchor="middle">${r.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;
    }),
    "</svg>"].join("");
  const sharp = (await import("sharp")).default;
  await sharp(path.join(dir, img.file)).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dir, "sketch-overlay.png"));
  const m2 = (r: (typeof out.rooms)[number]) => {
    let a = 0;
    r.polygon.forEach((p, i) => { const q = r.polygon[(i + 1) % r.polygon.length]; a += p.x * q.y - q.x * p.y; });
    return Math.abs(a / 2) / sketch.pxPerMeter ** 2;
  };
  for (const r of out.rooms) {
    const dims = r.printedDimensions?.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
    const printed = dims ? Number(dims[1]) * Number(dims[2]) : undefined;
    console.log(`${r.name.padEnd(28)} traced ${m2(r).toFixed(1).padStart(6)} m²${printed ? `   printed ${r.printedDimensions} = ${printed.toFixed(1)} m² (${Math.round((m2(r) / printed - 1) * 100)}%)` : ""}`);
  }
  console.log(`${out.walls.length} walls, ${out.walls.reduce((n, w) => n + w.openings.length, 0)} openings → ${path.join(dir, "answer.json")}\nCheck ${path.join(dir, "sketch-overlay.png")}`);
} else if (cmd === "zoom") {
  // enlarged crop with a pixel grid in the ORIGINAL image's coordinates, for tracing plans precisely
  const [img, x0, y0, x1, y1, out] = args;
  const sharp = (await import("sharp")).default;
  const meta = await sharp(img).metadata();
  const [l, t] = [Math.max(0, Number(x0 ?? 0)), Math.max(0, Number(y0 ?? 0))];
  const [r, b] = [Math.min(meta.width!, Number(x1 ?? meta.width)), Math.min(meta.height!, Number(y1 ?? meta.height))];
  const k = Math.max(1, Math.min(4, Math.floor(1400 / Math.max(r - l, b - t))));
  const W = (r - l) * k, H = (b - t) * k;
  const lines: string[] = [];
  for (let x = Math.ceil(l / 10) * 10; x <= r; x += 10) {
    const X = (x - l) * k, major = x % 50 === 0;
    lines.push(`<line x1="${X}" y1="0" x2="${X}" y2="${H}" stroke="${major ? "rgba(255,0,0,0.55)" : "rgba(0,120,255,0.18)"}" stroke-width="1"/>`);
    if (major) lines.push(`<text x="${X + 2}" y="12" font-size="12" font-family="sans-serif" fill="red">${x}</text>`);
  }
  for (let y = Math.ceil(t / 10) * 10; y <= b; y += 10) {
    const Y = (y - t) * k, major = y % 50 === 0;
    lines.push(`<line x1="0" y1="${Y}" x2="${W}" y2="${Y}" stroke="${major ? "rgba(255,0,0,0.55)" : "rgba(0,120,255,0.18)"}" stroke-width="1"/>`);
    if (major) lines.push(`<text x="2" y="${Y - 2}" font-size="12" font-family="sans-serif" fill="red">${y}</text>`);
  }
  const target = out ?? img.replace(/\.png$/, `.zoom-${l}-${t}-${r}-${b}.png`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join("")}</svg>`;
  await sharp(img).extract({ left: l, top: t, width: r - l, height: b - t }).resize({ width: W, height: H, kernel: "lanczos3" })
    .composite([{ input: Buffer.from(svg) }]).png().toFile(target);
  console.log(target);
} else {
  console.log(await fs.readFile(new URL(import.meta.url), "utf8").then((s) => s.split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")));
}
