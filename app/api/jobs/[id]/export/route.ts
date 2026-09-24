import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { jobFile, readJob } from "@/lib/store";
import { runExport } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Build exports/model.glb (+ scene graph JSON). ?attested=1 leaves out inferred geometry. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!(await readJob(id))) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const attested = new URL(req.url).searchParams.get("attested") === "1";
  const out = await runExport(id, { includeInferred: !attested });
  return NextResponse.json({ ok: true, ...out, glb: `/api/jobs/${id}/export?format=glb`, json: `/api/jobs/${id}/export?format=json` });
}

/** Download: ?format=glb (default) or json. Builds the export first if missing. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const format = new URL(req.url).searchParams.get("format") === "json" ? "json" : "glb";
  const rel = format === "glb" ? "exports/model.glb" : "exports/scene-graph.json";
  try {
    await fs.access(jobFile(id, rel));
  } catch {
    await runExport(id);
  }
  const data = await fs.readFile(jobFile(id, rel));
  const safe = job.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60) || id;
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "content-type": format === "glb" ? "model/gltf-binary" : "application/json",
      "content-disposition": `attachment; filename="${safe}.${format === "glb" ? "glb" : "scene-graph.json"}"`,
    },
  });
}
