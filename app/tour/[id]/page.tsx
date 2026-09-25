"use client";
// Full-screen guided walkthrough of a model: exterior, each floor, then its main rooms.
// /tour/<id> plays it; /tour/<id>?capture=1 waits for scripts/video.ts to step it frame by frame.
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Viewer3D } from "@/components/ViewerDynamic";
import type { PropertySceneGraph } from "@/lib/schema";
import { loadScene } from "@/lib/use-job";
import { fileUrl } from "@/lib/client-store";

export default function TourPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [scene, setScene] = useState<PropertySceneGraph | null | "missing">(null);
  const [capture, setCapture] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [restart, setRestart] = useState(0);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    setCapture(new URLSearchParams(window.location.search).has("capture"));
    void loadScene(id).then((g) => setScene(g ?? "missing"));
  }, [id]);
  if (scene === "missing") return <main className="min-h-screen flex items-center justify-center text-stone-400">This model is not available.</main>;
  if (!scene) return <main className="min-h-screen flex items-center justify-center text-stone-500">Loading…</main>;
  return (
    <main className="fixed inset-0 bg-black" data-testid="tour">
      <Viewer3D scene={scene} jobId={id} mode="tour" showInferred levelId="all" selectedId={null} measuring={false} capture={capture}
        tourPlaying={capture ? false : playing} tourRestart={restart} onTourEnd={() => setEnded(true)} />
      {!capture && (
        <div className="absolute top-4 right-4 flex gap-2 text-xs">
          <button className="btn" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          <button className="btn" onClick={() => { setRestart((n) => n + 1); setEnded(false); setPlaying(true); }}>Restart</button>
          <a className="btn" href={fileUrl(id, "exports/walkthrough.mp4")} download>Download video</a>
          <Link className="btn btn-gold" href={`/view/${id}`}>Explore the model</Link>
        </div>
      )}
      {ended && !capture && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex gap-3">
            <button className="btn" onClick={() => { setRestart((n) => n + 1); setEnded(false); }}>Watch again</button>
            <Link className="btn btn-gold" href={`/view/${id}`}>Explore the model</Link>
          </div>
        </div>
      )}
    </main>
  );
}
