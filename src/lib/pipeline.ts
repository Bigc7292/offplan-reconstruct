// Job state machine: create → ingest → classify → extract → review (human, mandatory) → reconstruct → export.
// Stages run in-process in the background; every step writes to logs.jsonl so the UI can stream it.
import { createJob, log, readDossier, readJob, setStage, updateJob, writeDossier, writeSceneGraph, writeJobFile, readSceneGraph } from "./store";
import type { Job, PropertyDossier, StageName } from "./schema";
import { emptyDossier } from "./schema";
import { buildDemoDossier } from "./demo";
import { reconstruct } from "./reconstruct";
import { exportGlb } from "./export-glb";
import { normalizeDossier } from "./normalize";
import { extractorKind, extractorLabel } from "./llm";

const running = new Set<string>();

export type NewJobInput = {
  files: Array<{ name: string; type: string; data: Buffer }>;
  urls: string[];
  unitFocus?: string;
  notes?: string;
  demo?: boolean;
};

export async function startJob(input: NewJobInput): Promise<Job> {
  const title = input.demo
    ? "DEMO — 2BR + Maid sample unit"
    : input.files[0]?.name.replace(/\.[a-z0-9]+$/i, "") ?? (input.urls[0] ? new URL(input.urls[0]).hostname : "Untitled");
  const job = await createJob({ title, unitFocus: input.unitFocus, notes: input.notes, extractor: input.demo ? "local" : extractorKind(), extractorLabel: input.demo ? undefined : extractorLabel(), demo: input.demo });
  await setStage(job.id, "create", "running");
  const { registerSources } = await import("./ingest");
  await registerSources(job.id, input);
  await setStage(job.id, "create", "done");
  await log(job.id, "create", `Job created with ${input.files.length} file(s) and ${input.urls.length} URL(s).`);
  void runToReview(job.id);
  return (await readJob(job.id))!;
}

async function stage<T>(id: string, name: StageName, fn: () => Promise<T>): Promise<T> {
  await setStage(id, name, "running");
  await updateJob(id, (j) => { j.status = "running"; });
  try {
    const out = await fn();
    await setStage(id, name, "done");
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log(id, name, `Stage failed: ${msg}`, "error");
    await setStage(id, name, "error", msg);
    await updateJob(id, (j) => { j.status = "error"; });
    throw e;
  }
}

/** Runs ingest → classify → extract, then parks the job in review. */
export async function runToReview(id: string, from: StageName = "ingest") {
  if (running.has(id)) return;
  running.add(id);
  try {
    const job = (await readJob(id))!;
    if (job.demo) {
      for (const s of ["ingest", "classify"] as const) {
        await setStage(id, s, "done");
      }
      await stage(id, "extract", async () => {
        const d = buildDemoDossier(id);
        await writeDossier(id, normalizeDossier(d));
        await log(id, "extract", "Loaded built-in DEMO unit (not an extracted project).", "warn");
      });
    } else {
      const order: StageName[] = ["ingest", "classify", "extract"];
      const { ingestAll } = await import("./ingest");
      const { classifyAll } = await import("./classify");
      const { extractAll } = await import("./extract");
      for (const s of order.slice(order.indexOf(from))) {
        if (s === "ingest") await stage(id, "ingest", () => ingestAll(id));
        if (s === "classify") await stage(id, "classify", () => classifyAll(id));
        if (s === "extract") await stage(id, "extract", () => extractAll(id));
      }
    }
    await setStage(id, "review", "waiting");
    await updateJob(id, (j) => { j.status = "review"; });
    await log(id, "review", "Waiting for human review: check rooms, dimensions and finishes, then generate the 3D model.");
  } catch {
    // stage() already recorded the error
  } finally {
    running.delete(id);
  }
}

/** Human review done (or a later edit): rebuild the scene graph from the dossier. Deterministic. */
export async function runReconstruct(id: string) {
  return stage(id, "reconstruct", async () => {
    const d = await readDossier(id);
    if (!d) throw new Error("No dossier yet — run extraction first.");
    await setStage(id, "review", "done");
    const g = reconstruct(d);
    await writeSceneGraph(id, g);
    await log(id, "reconstruct", `Built ${g.stats.rooms} rooms, ${g.stats.walls} walls, ${g.stats.openings} openings (${g.stats.inferredPieces} inferred pieces). Hash ${g.dossierHash}.`);
    for (const w of g.warnings) await log(id, "reconstruct", w, "warn");
    await updateJob(id, (j) => { j.status = "ready"; });
    return g;
  });
}

export async function runExport(id: string, opts: { includeInferred?: boolean } = {}) {
  return stage(id, "export", async () => {
    let g = await readSceneGraph(id);
    const d = await readDossier(id);
    if (!g || (d && g.dossierHash !== (await import("./reconstruct")).dossierHash(d))) g = await runReconstruct(id);
    const glb = exportGlb(g, opts);
    await writeJobFile(id, "exports/model.glb", glb);
    await writeJobFile(id, "exports/scene-graph.json", JSON.stringify(g, null, 2));
    await log(id, "export", `Exported GLB (${(glb.length / 1024).toFixed(0)} KB) and scene graph JSON.`);
    return { bytes: glb.length };
  });
}

/** Apply a reviewed/edited dossier. */
export async function saveDossier(id: string, d: PropertyDossier) {
  const saved = await writeDossier(id, normalizeDossier({ ...d, jobId: id }));
  return saved;
}

export async function ensureDossier(id: string): Promise<PropertyDossier> {
  return (await readDossier(id)) ?? emptyDossier(id);
}
