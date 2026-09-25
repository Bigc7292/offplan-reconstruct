"use client";
// Rendered views of the reconstructed model (Blender Cycles, made through the Blender MCP by
// scripts/blender/render_job.py). Shown as the first thing a buyer sees on the share page.
import { useEffect, useState } from "react";
import { fileUrl } from "@/lib/client-store";

export type RenderShot = { name: string; kind: "exterior" | "cutaway" | "interior"; title: string; file: string; level?: string; room?: string };
export type RenderIndex = { dossierHash?: string; renderedAt: string; engine: string; note: string; shots: RenderShot[] };

/** Renders of the model, when they were made from this version of it (`dossierHash`): a rebuild makes older ones stale. */
export function useRenders(jobId: string, dossierHash?: string) {
  const [idx, setIdx] = useState<RenderIndex | null>(null);
  useEffect(() => {
    let live = true;
    fetch(fileUrl(jobId, "renders/index.json"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.shots?.length && (!dossierHash || j.dossierHash === dossierHash)) setIdx(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [jobId, dossierHash]);
  return idx;
}

/** The walkthrough MP4 made by scripts/video.ts, when the job has one. */
export function useWalkthroughVideo(jobId: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const u = fileUrl(jobId, "exports/walkthrough.mp4");
    fetch(u, { headers: { range: "bytes=0-0" }, cache: "no-store" })
      .then((r) => { if (live && (r.status === 206 || r.ok)) setUrl(u); })
      .catch(() => {});
    return () => { live = false; };
  }, [jobId]);
  return url;
}

export function WalkthroughVideo({ url, poster, onClose }: { url: string; poster?: string; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-black" data-testid="walkthrough-video">
      <video src={url} poster={poster} controls autoPlay playsInline className="min-h-0 flex-1 w-full bg-black" />
      <div className="flex items-center gap-2 border-t border-stone-800 p-2 text-xs">
        <span className="text-stone-400">Walkthrough of the reconstructed model. Furniture is illustrative; colours and finishes come from the brochure.</span>
        <a className="btn ml-auto" href={`${url}?download=1`}>Download MP4</a>
        <button className="btn btn-gold" onClick={onClose}>Explore in 3D</button>
      </div>
    </div>
  );
}

export function RenderGallery({ jobId, index, onOpenRoom }: { jobId: string; index: RenderIndex; onOpenRoom?: (roomId: string) => void }) {
  const [i, setI] = useState(0);
  const shot = index.shots[i];
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((n) => (n + 1) % index.shots.length);
      if (e.key === "ArrowLeft") setI((n) => (n - 1 + index.shots.length) % index.shots.length);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index.shots.length]);
  return (
    <div className="absolute inset-0 flex flex-col bg-stone-950" data-testid="render-gallery">
      <div className="relative flex-1 min-h-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fileUrl(jobId, shot.file)} alt={shot.title} className="absolute inset-0 h-full w-full object-contain" />
        <div className="absolute left-4 top-4 rounded-md bg-stone-950/75 px-3 py-2 backdrop-blur">
          <div className="text-[10px] uppercase tracking-[0.25em] text-champagne-300">{shot.kind === "exterior" ? "Exterior" : shot.kind === "cutaway" ? "Floor layout" : "Interior"}</div>
          <div className="text-stone-100">{shot.title}</div>
        </div>
        {shot.room && onOpenRoom && (
          <button className="btn btn-gold absolute right-4 top-4" onClick={() => onOpenRoom(shot.room!)}>Walk this room in 3D</button>
        )}
        <button aria-label="Previous" className="absolute left-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-stone-950/70 text-stone-100 hover:bg-stone-900" onClick={() => setI((n) => (n - 1 + index.shots.length) % index.shots.length)}>‹</button>
        <button aria-label="Next" className="absolute right-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-stone-950/70 text-stone-100 hover:bg-stone-900" onClick={() => setI((n) => (n + 1) % index.shots.length)}>›</button>
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-stone-950/70 px-2 py-1 text-[10px] text-stone-300">{index.note}</div>
      </div>
      <div className="flex gap-2 overflow-x-auto scroll-thin border-t border-stone-800 p-2">
        {index.shots.map((s, k) => (
          <button key={s.name} onClick={() => setI(k)} className={`shrink-0 rounded border ${k === i ? "border-champagne-400" : "border-stone-700 opacity-70 hover:opacity-100"}`} title={s.title}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(jobId, s.file)} alt={s.title} className="h-16 w-28 object-cover rounded" />
          </button>
        ))}
      </div>
    </div>
  );
}
