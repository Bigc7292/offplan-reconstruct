// Runs the pipeline to review on the given PDFs without the web server.
// Usage: npx tsx scripts/ingest-test.ts file1.pdf [file2.pdf ...]
import fs from "node:fs";
import path from "node:path";
import { startJob } from "@/lib/pipeline";
import { readJob, readDossier } from "@/lib/store";

const files = process.argv.slice(2);
const job = await startJob({ files: files.map((f) => ({ name: path.basename(f), type: "application/pdf", data: fs.readFileSync(f) })), urls: [] });
// startJob kicks the pipeline off in the background; wait for it here
for (;;) {
  const j = (await readJob(job.id))!;
  if (j.status === "review" || j.status === "error") break;
  await new Promise((r) => setTimeout(r, 1000));
}
const j = (await readJob(job.id))!;
const d = await readDossier(job.id);
console.log("JOB", job.id, j.status, j.stages.map((s) => `${s.name}:${s.status}${s.error ? "(" + s.error + ")" : ""}`).join(" "));
for (const p of j.pages) console.log(`p${p.n}`, p.labels.join(","), p.caption ?? "", "|", p.textSource, p.text.slice(0, 60).replace(/\n/g, " / "));
if (d) {
  console.log("project", d.projectName, "| location", d.location);
  console.log("facts", d.facts.map((f) => `${f.key}=${f.value}`).join("\n  "));
  console.log("unitTypes", JSON.stringify(d.unitTypes));
  console.log("levels", d.levels.map((l) => `${l.name} @${l.elevationM} rooms:${l.rooms.map((r) => r.name).join("|")}`).join("\n  "));
  console.log("materials", d.materials.map((m) => `${m.name} ${m.albedoHint} ${m.programs}`).join("\n  "));
  console.log("assets", d.assets.map((a) => `${a.id}:${a.kind}:${a.caption ?? ""}`).join("\n  "));
  console.log("warnings", d.warnings.join("\n  "));
  console.log("completeness", d.completeness);
}
