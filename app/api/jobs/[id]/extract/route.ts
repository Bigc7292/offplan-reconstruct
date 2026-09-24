import { NextResponse } from "next/server";
import { readJob } from "@/lib/store";
import { runToReview } from "@/lib/pipeline";

export const runtime = "nodejs";

/** Re-run classification + extraction on the already-ingested pages. Replaces dossier.json. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await readJob(id))) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const from = new URL(req.url).searchParams.get("from") === "extract" ? "extract" : "classify";
  void runToReview(id, from);
  return NextResponse.json({ ok: true });
}
