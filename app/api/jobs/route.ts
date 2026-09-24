import { NextResponse } from "next/server";
import { listJobs } from "@/lib/store";
import { startJob } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json(jobs.map((j) => ({ id: j.id, title: j.title, status: j.status, createdAt: j.createdAt, demo: !!j.demo, pages: j.pages.length, sources: j.sources.length })));
}

/** Create a job. multipart/form-data: files[], urls (newline separated), unitFocus, notes — or JSON {demo:true}. */
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = await req.json();
    if (!body.demo && !(body.urls?.length)) return NextResponse.json({ error: "Provide files, URLs, or demo:true" }, { status: 400 });
    const job = await startJob({ files: [], urls: body.urls ?? [], unitFocus: body.unitFocus, notes: body.notes, demo: !!body.demo });
    return NextResponse.json({ id: job.id });
  }
  const form = await req.formData();
  const files: Array<{ name: string; type: string; data: Buffer }> = [];
  for (const f of form.getAll("files")) {
    if (typeof f === "string") continue;
    files.push({ name: f.name, type: f.type, data: Buffer.from(await f.arrayBuffer()) });
  }
  const urls = String(form.get("urls") ?? "").split(/[\s,]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
  if (!files.length && !urls.length) return NextResponse.json({ error: "Add at least one PDF, image or listing URL." }, { status: 400 });
  const job = await startJob({ files, urls, unitFocus: String(form.get("unitFocus") ?? "") || undefined, notes: String(form.get("notes") ?? "") || undefined });
  return NextResponse.json({ id: job.id });
}
