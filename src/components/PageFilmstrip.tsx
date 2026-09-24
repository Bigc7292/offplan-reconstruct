"use client";
import type { Job } from "@/lib/schema";
import { fileUrl } from "@/lib/client-store";

export function PageFilmstrip({ job, active, onPick }: { job: Job; active?: number; onPick: (n: number) => void }) {
  if (!job.pages.length) {
    return (
      <div className="panel p-4 text-sm text-stone-400">
        {job.status === "running" || job.status === "queued" ? "Rasterising pages…" : "No pages ingested yet."}
      </div>
    );
  }
  return (
    <div className="panel p-3">
      <div className="flex gap-3 overflow-x-auto scroll-thin pb-1">
        {job.pages.map((p) => {
          const classified = p.labels.length > 0;
          return (
            <button key={p.n} onClick={() => onPick(p.n)} className={`group shrink-0 w-32 text-left rounded-md border ${active === p.n ? "border-champagne-400" : "border-stone-700 hover:border-stone-500"} bg-stone-900 overflow-hidden transition`}>
              <div className="relative h-20 bg-stone-950">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(job.id, p.thumb)} alt={`Page ${p.n}`} className={`h-full w-full object-cover transition duration-700 ${classified ? "" : "grayscale opacity-60"}`} loading="lazy" />
                <span className="absolute left-1 top-1 rounded bg-stone-950/80 px-1 text-[10px] text-stone-300">p{p.n}</span>
                {p.languages.includes("ar") && <span className="absolute right-1 top-1 rounded bg-stone-950/80 px-1 text-[10px] text-champagne-300">AR</span>}
              </div>
              <div className="p-1.5 space-y-0.5">
                <div className="flex flex-wrap gap-1">
                  {classified ? p.labels.map((l) => <span key={l} className="text-[9px] uppercase tracking-wider text-champagne-300">{l.replace("_", " ")}</span>) : <span className="text-[9px] text-stone-500">classifying…</span>}
                </div>
                {p.caption && <div className="text-[10px] text-stone-400 truncate">{p.caption}</div>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
