import { NextResponse } from "next/server";
import { readJob } from "@/lib/store";
import { runToReview } from "@/lib/pipeline";

export const runtime = "nodejs";

/** Re-run the pipeline from ingest (keeps preserved sources). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await readJob(id))) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  void runToReview(id, "ingest");
  return NextResponse.json({ ok: true });
}
