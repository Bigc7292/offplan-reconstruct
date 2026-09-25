import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { jobFile } from "@/lib/store";

export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".html": "text/plain; charset=utf-8",
  ".glb": "model/gltf-binary", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm",
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
    const ext = path.extname(file).toLowerCase();
    const download = new URL(req.url).searchParams.get("download") === "1";
    // videos are served in byte ranges so the player can seek
    const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (ext === ".mp4" || ext === ".webm")) {
      const { size } = await fs.stat(file);
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      const fh = await fs.open(file, "r");
      const buf = Buffer.alloc(end - start + 1);
      try { await fh.read(buf, 0, buf.length, start); } finally { await fh.close(); }
      return new NextResponse(new Uint8Array(buf), {
        status: 206,
        headers: { "content-type": TYPES[ext], "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": String(buf.length), "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" },
      });
    }
    const data = await fs.readFile(file);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        ...(ext === ".mp4" || ext === ".webm" ? { "accept-ranges": "bytes" } : {}),
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
