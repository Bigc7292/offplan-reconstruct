import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { jobFile, readJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rough scene graph built from the floors read so far, while extraction is still running. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await readJob(id))) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  try {
    return new NextResponse(await fs.readFile(jobFile(id, "preview-scene.json"), "utf8"), { headers: { "content-type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "No floors read yet" }, { status: 404 });
  }
}
