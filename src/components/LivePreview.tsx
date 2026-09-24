"use client";
// Shown while the brochure is being read: the 3D model grows floor by floor as each plan comes back.
import { useEffect, useState } from "react";
import { Viewer3D } from "./ViewerDynamic";
import type { Job, PropertySceneGraph } from "@/lib/schema";

type Preview = PropertySceneGraph & { preview?: { levelsRead: number; updatedAt: string } };

export function LivePreview({ job }: { job: Job }) {
  const [scene, setScene] = useState<Preview | null>(null);
  const stage = (n: string) => job.stages.find((s) => s.name === n)?.status;
  const active = stage("extract") === "running" || stage("classify") === "running" || stage("ingest") === "running";

  useEffect(() => {
    if (!active) return;
    let stop = false;
    let last = "";
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${job.id}/preview`, { cache: "no-store" });
        if (res.ok) {
          const g = (await res.json()) as Preview;
          if (!stop && g.preview?.updatedAt !== last) { last = g.preview?.updatedAt ?? ""; setScene(g); }
        }
      } catch { /* keep polling */ }
      if (!stop) setTimeout(tick, 4000);
    };
    void tick();
    return () => { stop = true; };
  }, [job.id, active]);

  if (!active) return null;
  const pages = job.pages.length;
  const sorted = job.pages.filter((p) => p.labels.length).length;
  const headline =
    stage("ingest") === "running" ? "Opening your brochure…" :
    stage("classify") === "running" ? `Sorting pages${pages ? ` (${pages} found)` : ""}…` :
    scene ? `Building your model: ${scene.preview?.levelsRead ?? scene.levels.length} floor${(scene.preview?.levelsRead ?? 1) === 1 ? "" : "s"} read so far` :
    "Reading the floor plans…";

  return (
    <div className="panel overflow-hidden" data-testid="live-preview">
      <div className="px-4 py-3 flex items-center gap-3 border-b border-stone-800">
        <span className="h-2 w-2 rounded-full bg-champagne-300 animate-pulse" />
        <div className="text-stone-100">{headline}</div>
        <div className="ml-auto text-xs text-stone-500">{sorted ? `${sorted}/${pages} pages sorted · ` : ""}this usually takes a few minutes</div>
      </div>
      <div className="h-[420px]">
        {scene ? (
          <Viewer3D scene={scene} jobId={job.id} mode="dollhouse" compact showInferred levelId="all"
            selectedId={null} pulseKey={0} measuring={false} watermark />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-stone-500 px-6 text-center">
            Your 3D model will start appearing here as soon as the first floor plan has been read.
          </div>
        )}
      </div>
    </div>
  );
}
