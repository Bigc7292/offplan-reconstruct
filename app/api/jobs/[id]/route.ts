import { NextResponse } from "next/server";
import { readDossier, readJob, readLogs, readSceneGraph } from "@/lib/store";
import { saveDossier } from "@/lib/pipeline";
import { PropertyDossierSchema } from "@/lib/schema";
import { dossierHash } from "@/lib/reconstruct";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Job state + dossier + logs (pass ?since=N to get only new log lines). */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  const [dossier, logs, scene] = await Promise.all([readDossier(id), readLogs(id, since), readSceneGraph(id)]);
  return NextResponse.json({
    job, dossier, logs, logOffset: since + logs.length,
    scene: scene ? { dossierHash: scene.dossierHash, stats: scene.stats, stale: dossier ? scene.dossierHash !== dossierHash(dossier) : false } : null,
  });
}

/** Save review edits to dossier.json. */
export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!(await readJob(id))) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const parsed = PropertyDossierSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid dossier", issues: parsed.error.issues.slice(0, 20) }, { status: 400 });
  const saved = await saveDossier(id, parsed.data);
  return NextResponse.json({ dossier: saved, dossierHash: dossierHash(saved) });
}
