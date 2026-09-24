import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { jobFile } from "@/lib/store";

export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".html": "text/plain; charset=utf-8",
  ".glb": "model/gltf-binary", ".svg": "image/svg+xml",
};

/** Serve a file from the job folder (page images, preserved sources, assets, exports). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path: parts } = await params;
  let file: string;
  try {
    file = jobFile(id, parts.map(decodeURIComponent).join("/"));
  } catch {
    return NextResponse.json({ error: "bad path" }, { status: 400 });
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const download = new URL(req.url).searchParams.get("download") === "1";
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "cache-control": "private, max-age=3600",
        // uploaded HTML/SVG from listings is never rendered inline
        ...(download || ext === ".html" ? { "content-disposition": `attachment; filename="${path.basename(file)}"` } : {}),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
