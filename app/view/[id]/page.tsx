"use client";
// Public share view: the model and its evidence, no editing chrome.
import { use, useEffect, useState } from "react";
import { ModelExplorer } from "@/components/ModelExplorer";
import { useStudio } from "@/lib/client-store";
import type { PropertyDossier, PropertySceneGraph, SourceRecord } from "@/lib/schema";
import { loadScene } from "@/lib/use-job";

export default function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [state, setState] = useState<{ scene: PropertySceneGraph | null; dossier: PropertyDossier | null; sources: SourceRecord[] } | "missing" | null>(null);
  useEffect(() => {
    void (async () => {
      const [g, jr] = await Promise.all([loadScene(id), fetch(`/api/jobs/${id}`).then((r) => (r.ok ? r.json() : null))]);
      if (!g) return setState("missing");
      useStudio.setState({ jobId: id, dossier: jr?.dossier ?? null });
      setState({ scene: g, dossier: jr?.dossier ?? null, sources: jr?.job.sources ?? [] });
    })();
  }, [id]);
  if (state === "missing") return <main className="min-h-screen flex items-center justify-center text-stone-400">This model is not available.</main>;
  if (!state?.scene) return <main className="min-h-screen flex items-center justify-center text-stone-500">Loading…</main>;
  return <ModelExplorer jobId={id} scene={state.scene} dossier={state.dossier} sources={state.sources} share />;
}
