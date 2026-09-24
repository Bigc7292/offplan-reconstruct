import { NextResponse } from "next/server";
import { readDossier, readJob, readSceneGraph } from "@/lib/store";
import { dossierHash } from "@/lib/reconstruct";
import { runReconstruct } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The scene graph for the viewer. Rebuilt on the server if the dossier changed since the last build. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  let g = await readSceneGraph(id);
  const d = await readDossier(id);
  if (d && (!g || g.dossierHash !== dossierHash(d)) && job.stages.find((s) => s.name === "reconstruct")?.status !== "pending") {
    g = await runReconstruct(id);
  }
  if (!g) return NextResponse.json({ error: "No model yet — review the dossier and generate the 3D model." }, { status: 404 });
  return NextResponse.json(g);
}
