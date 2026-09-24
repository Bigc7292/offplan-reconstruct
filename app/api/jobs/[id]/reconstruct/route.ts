import { NextResponse } from "next/server";
import { readJob } from "@/lib/store";
import { runReconstruct } from "@/lib/pipeline";

export const runtime = "nodejs";

/** Deterministically rebuild scene-graph.json from dossier.json. Returns the scene graph. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await readJob(id))) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  try {
    const g = await runReconstruct(id);
    return NextResponse.json(g);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
