"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ModelExplorer } from "@/components/ModelExplorer";
import { useStudio } from "@/lib/client-store";
import { loadScene, useJobPolling } from "@/lib/use-job";

export default function ModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  useJobPolling(id);
  const { job, dossier, scene } = useStudio();
  const [missing, setMissing] = useState(false);
  useEffect(() => { void loadScene(id).then((g) => setMissing(!g)); }, [id]);
  if (missing && !scene) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 text-stone-400">
        No model yet.
        <Link className="btn btn-gold" href={`/jobs/${id}`}>Review the dossier</Link>
      </main>
    );
  }
  if (!scene || !job) return <main className="min-h-screen flex items-center justify-center text-stone-500">Building the model…</main>;
  return <ModelExplorer jobId={id} scene={scene} dossier={dossier} sources={job.sources} />;
}
