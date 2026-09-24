// Job storage: one folder per job under DATA_DIR (default ./data/jobs).
//
// /data/jobs/{id}/
//   job.json            job state (stages, sources, page records)
//   logs.jsonl          pipeline log, one JSON line per entry
//   model-calls.jsonl   every model call: prompt, schema, token usage
//   source/             preserved originals
//   pages/{n}.png|.txt|.thumb.jpg
//   assets/{hash}.{ext}
//   dossier.json  scene-graph.json  evidence.json
//   exports/model.glb
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  JobSchema, PropertyDossierSchema, STAGES,
  type Job, type LogEntry, type PropertyDossier, type PropertySceneGraph, type StageName,
} from "./schema";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data", "jobs"));

export function jobDir(id: string) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad job id");
  return path.join(DATA_DIR, id);
}

/** Resolve a job-relative path, refusing anything that escapes the job folder. */
export function jobFile(id: string, rel: string) {
  const base = jobDir(id);
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error("path escapes job folder");
  return p;
}

export function sha256(buf: Buffer | string) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function newJobId() {
  const t = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${t}-${crypto.randomBytes(4).toString("hex")}`;
}

async function writeAtomic(file: string, data: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// Serialise job.json writes per job so concurrent stage updates never clobber each other.
const locks = new Map<string, Promise<unknown>>();
export function withJobLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => undefined));
  return next;
}

export async function createJob(init: Pick<Job, "title" | "unitFocus" | "notes" | "extractor" | "extractorLabel" | "demo">): Promise<Job> {
  const id = newJobId();
  const now = new Date().toISOString();
  const job: Job = {
    id,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    stages: STAGES.map((name) => ({ name, status: "pending" as const })),
    sources: [],
    pages: [],
    ...init,
  };
  await fs.mkdir(path.join(jobDir(id), "source"), { recursive: true });
  await fs.mkdir(path.join(jobDir(id), "pages"), { recursive: true });
  await fs.mkdir(path.join(jobDir(id), "assets"), { recursive: true });
  await fs.mkdir(path.join(jobDir(id), "exports"), { recursive: true });
  await writeAtomic(path.join(jobDir(id), "job.json"), JSON.stringify(job, null, 2));
  return job;
}

export async function readJob(id: string): Promise<Job | null> {
  try {
    const raw = await fs.readFile(path.join(jobDir(id), "job.json"), "utf8");
    return JobSchema.parse(JSON.parse(raw));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function updateJob(id: string, mut: (j: Job) => void | Promise<void>): Promise<Job> {
  return withJobLock(id, async () => {
    const job = await readJob(id);
    if (!job) throw new Error(`job ${id} not found`);
    await mut(job);
    job.updatedAt = new Date().toISOString();
    await writeAtomic(path.join(jobDir(id), "job.json"), JSON.stringify(JobSchema.parse(job), null, 2));
    return job;
  });
}

export async function setStage(id: string, name: StageName, status: Job["stages"][number]["status"], error?: string) {
  return updateJob(id, (j) => {
    const s = j.stages.find((x) => x.name === name)!;
    s.status = status;
    if (status === "running") { s.startedAt = new Date().toISOString(); s.finishedAt = undefined; s.error = undefined; }
    if (status === "done" || status === "error" || status === "waiting") s.finishedAt = new Date().toISOString();
    if (error) s.error = error;
  });
}

export async function listJobs(): Promise<Job[]> {
  try {
    const ids = await fs.readdir(DATA_DIR);
    const jobs = await Promise.all(ids.map((id) => readJob(id).catch(() => null)));
    return (jobs.filter(Boolean) as Job[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function log(id: string, stage: string, msg: string, level: LogEntry["level"] = "info") {
  const e: LogEntry = { t: new Date().toISOString(), stage, level, msg };
  await fs.appendFile(path.join(jobDir(id), "logs.jsonl"), JSON.stringify(e) + "\n");
}

export async function readLogs(id: string, since = 0): Promise<LogEntry[]> {
  try {
    const raw = await fs.readFile(path.join(jobDir(id), "logs.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).slice(since).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function logModelCall(id: string, entry: Record<string, unknown>) {
  await fs.appendFile(
    path.join(jobDir(id), "model-calls.jsonl"),
    JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n",
  );
}

export async function readDossier(id: string): Promise<PropertyDossier | null> {
  try {
    return PropertyDossierSchema.parse(JSON.parse(await fs.readFile(path.join(jobDir(id), "dossier.json"), "utf8")));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeDossier(id: string, d: PropertyDossier) {
  const parsed = PropertyDossierSchema.parse(d);
  await writeAtomic(path.join(jobDir(id), "dossier.json"), JSON.stringify(parsed, null, 2));
  // evidence.json: flat index of every evidence record keyed by element id, for quick lookup/debugging
  const index: Record<string, unknown> = {};
  for (const f of parsed.facts) index[`fact:${f.key}`] = f.evidence;
  for (const l of parsed.levels) {
    for (const r of l.rooms) index[r.id] = r.evidence;
    for (const w of l.walls) {
      index[w.id] = w.evidence;
      for (const o of w.openings) index[o.id] = o.evidence;
    }
    for (const f of l.furniture ?? []) index[f.id] = f.evidence;
  }
  for (const m of parsed.materials) index[m.id] = m.evidence;
  await writeAtomic(path.join(jobDir(id), "evidence.json"), JSON.stringify(index, null, 2));
  return parsed;
}

export async function readSceneGraph(id: string): Promise<PropertySceneGraph | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(jobDir(id), "scene-graph.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function writeSceneGraph(id: string, g: PropertySceneGraph) {
  await writeAtomic(path.join(jobDir(id), "scene-graph.json"), JSON.stringify(g));
}

export async function writeJobFile(id: string, rel: string, data: string | Buffer) {
  await writeAtomic(jobFile(id, rel), data);
}

export function jobFileExists(id: string, rel: string) {
  return fss.existsSync(jobFile(id, rel));
}
