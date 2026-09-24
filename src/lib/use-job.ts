"use client";
// Polls the job endpoint into the studio store, fast while the pipeline runs.
import { useEffect } from "react";
import { useStudio } from "./client-store";
import type { PropertySceneGraph } from "./schema";

export function useJobPolling(id: string) {
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const s = useStudio;
    if (s.getState().jobId !== id) s.setState({ jobId: id, job: null, dossier: null, scene: null, logs: [], logOffset: 0, selection: null, pageFocus: null, levelId: null, dirty: false });
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${id}?since=${s.getState().logOffset}`, { cache: "no-store" });
        if (res.ok) {
          const body = await res.json();
          s.getState().setJobData(body);
          if (body.scene && !s.getState().scene) await loadScene(id);
          if (stop) return;
          const busy = body.job.status === "running" || body.job.status === "queued";
          timer = setTimeout(tick, busy ? 1200 : 5000);
          return;
        }
      } catch { /* retry */ }
      if (!stop) timer = setTimeout(tick, 3000);
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);
}

export async function loadScene(id: string): Promise<PropertySceneGraph | null> {
  const res = await fetch(`/api/jobs/${id}/scene`, { cache: "no-store" });
  if (!res.ok) return null;
  const g = (await res.json()) as PropertySceneGraph;
  useStudio.getState().setScene(g);
  return g;
}
