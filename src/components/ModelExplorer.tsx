"use client";
// Full-screen model explorer used by /jobs/[id]/model (with review links) and /view/[id] (share).
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PropertyDossier, PropertySceneGraph, SourceRecord } from "@/lib/schema";
import { Viewer3D } from "./ViewerDynamic";
import type { ViewMode } from "./Viewer3D";
import type { PickInfo } from "@/scene/UnitMesh";
import type { WalkPose } from "@/scene/WalkControls";
import { EvidenceDrawer, describeElement } from "./Evidence";
import { Brand } from "./Brand";
import { fileUrl, useStudio } from "@/lib/client-store";
import { RenderGallery, WalkthroughVideo, useRenders, useWalkthroughVideo } from "./RenderGallery";

type Props = { jobId: string; scene: PropertySceneGraph; dossier: PropertyDossier | null; sources: SourceRecord[]; share?: boolean };

export function ModelExplorer({ jobId, scene, dossier, sources, share }: Props) {
  const select = useStudio((s) => s.select);
  const selection = useStudio((s) => s.selection);
  const pulse = useStudio((s) => s.pulse);
  const [mode, setMode] = useState<ViewMode>("dollhouse");
  const renders = useRenders(jobId);
  // buyers opening a shared link land on the rendered views first; the 3D model is one click away
  const [gallery, setGallery] = useState<boolean | null>(null);
  const showGallery = !!renders && (gallery ?? !!share);
  const video = useWalkthroughVideo(jobId);
  const [showVideo, setShowVideo] = useState(false);
  const [showInferred, setShowInferred] = useState(true);
  const [levelId, setLevelId] = useState<string | "all">(scene.spawn.levelId || scene.levels[0]?.id || "all");
  const [measuring, setMeasuring] = useState(false);
  const [mood, setMood] = useState<"day" | "dusk">("day");
  const [overlayOn, setOverlayOn] = useState(false);
  const [jump, setJump] = useState<{ roomId: string; n: number } | null>(null);
  const [pick, setPick] = useState<PickInfo | null>(null);
  const [azimuth, setAzimuth] = useState(0);
  const [pose, setPose] = useState<WalkPose | null>(null);
  const [locked, setLocked] = useState(false);
  const [miniMap, setMiniMap] = useState(true);
  const [exporting, setExporting] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  const activeLevel = levelId === "all" ? scene.spawn.levelId : levelId;
  const dLevel = dossier?.levels.find((l) => l.id === activeLevel);
  const overlay = overlayOn && dLevel?.plan ? {
    url: fileUrl(jobId, dLevel.plan.imagePath), pxPerM: dLevel.plan.pxPerM, originPx: dLevel.plan.originPx,
    imageW: dLevel.plan.imageW, imageH: dLevel.plan.imageH, elevationM: dLevel.elevationM,
  } : null;
  const rooms = scene.rooms.filter((r) => (levelId === "all" || r.levelId === levelId) && (showInferred || !r.inferred));
  const info = dossier && pick ? describeElement(dossier, scene, pick.piece.elementId, pick.piece.elementKind, pick.piece.materialId)
    : dossier && selection ? describeElement(dossier, scene, selection.id) : null;

  const jumpTo = (roomId: string) => {
    const r = scene.rooms.find((x) => x.id === roomId);
    // walking always happens on the room's own floor; in dollhouse, follow the room unless showing every floor
    if (r && (mode === "walk" || levelId !== "all") && r.levelId !== levelId) setLevelId(r.levelId);
    setJump((j) => ({ roomId, n: (j?.n ?? 0) + 1 }));
    setPick(null);
    select({ id: roomId, kind: "room", levelId: r?.levelId }, true);
  };

  const exportGlb = async (attested: boolean) => {
    setExporting(attested ? "attested" : "all");
    const res = await fetch(`/api/jobs/${jobId}/export${attested ? "?attested=1" : ""}`, { method: "POST" });
    setExporting("");
    if (res.ok) window.location.href = `/api/jobs/${jobId}/export?format=glb`;
  };
  const screenshot = () => {
    const c = canvas.current;
    if (!c) return;
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = `${scene.title.replace(/[^a-z0-9]+/gi, "-")}-${mode}.png`;
    a.click();
  };
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/view/${jobId}` : `/view/${jobId}`;
  // arrow rotates clockwise as the view turns left (yaw and orbit azimuth are both CCW-positive)
  const northDeg = (scene.northDeg ?? 0) + (mode === "walk" ? (pose?.yawDeg ?? 0) : mode === "plan" ? 0 : azimuth);

  return (
    <div className="h-screen flex flex-col">
      <header className="px-5 py-3 flex items-center gap-3 border-b border-stone-800">
        <Brand small />
        <div className="min-w-0">
          <div className="truncate text-stone-100" data-testid="model-title">{scene.title}</div>
          <div className="text-[11px] text-stone-500">{scene.stats.rooms} rooms · {scene.stats.walls} walls · {scene.stats.openings} openings · {scene.stats.inferredPieces} inferred pieces · model {scene.dossierHash}</div>
        </div>
        {scene.demo && <span className="chip chip-inferred">DEMO</span>}
        <div className="ml-auto flex items-center gap-2 text-xs">
          {!share && <Link className="btn" href={`/jobs/${jobId}`}>Back to review</Link>}
          <button className="btn" onClick={screenshot}>Screenshot</button>
          <button className="btn" onClick={() => exportGlb(!showInferred)} disabled={!!exporting} data-testid="export-glb">{exporting ? "Exporting…" : showInferred ? "Export GLB" : "Export GLB (attested only)"}</button>
          <a className="btn" href={`/api/jobs/${jobId}/export?format=json`}>Scene JSON</a>
          {!share && (
            <button className="btn btn-gold" onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); } catch { /* insecure context */ } setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? "Link copied" : "Share link"}
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[220px_minmax(0,1fr)_320px]">
        <aside className="border-r border-stone-800 p-3 space-y-4 overflow-auto scroll-thin text-sm">
          <div>
            <div className="label mb-1.5">View</div>
            <div className="grid grid-cols-3 gap-1">
              {(["dollhouse", "walk", "plan"] as const).map((m) => (
                <button key={m} data-testid={`mode-${m}`} onClick={() => { setMode(m); setMeasuring(false); setGallery(false); setShowVideo(false); }} className={`btn !px-1 !text-xs capitalize ${mode === m && !showGallery ? "btn-gold" : ""}`}>{m}</button>
              ))}
            </div>
            {renders && (
              <button data-testid="mode-renders" onClick={() => { setGallery(true); setShowVideo(false); }} className={`btn w-full mt-1 !text-xs ${showGallery ? "btn-gold" : ""}`}>Rendered views ({renders.shots.length})</button>
            )}
            {video ? (
              <button data-testid="mode-video" onClick={() => setShowVideo(true)} className={`btn w-full mt-1 !text-xs ${showVideo ? "btn-gold" : ""}`}>▶ Walkthrough video</button>
            ) : (
              <Link data-testid="mode-tour" href={`/tour/${jobId}`} className="btn w-full mt-1 !text-xs">▶ Guided tour</Link>
            )}
          </div>
          {scene.levels.length > 1 && (
            <div>
              <div className="label mb-1.5">Levels</div>
              <div className="flex flex-wrap gap-1">
                {mode !== "walk" && <button className={`chip ${levelId === "all" ? "chip-gold" : ""}`} onClick={() => setLevelId("all")}>All</button>}
                {scene.levels.map((l) => <button key={l.id} data-testid="level-chip" className={`chip ${levelId === l.id ? "chip-gold" : ""}`} onClick={() => setLevelId(l.id)}>{l.name}</button>)}
              </div>
            </div>
          )}
          <div>
            <div className="label mb-1.5">Rooms</div>
            <ul className="space-y-0.5" data-testid="room-list">
              {rooms.map((r, i) => (
                <li key={r.id}>
                  {levelId === "all" && r.levelId !== rooms[i - 1]?.levelId && <div className="label mt-2 mb-0.5 px-2 text-stone-500">{scene.levels.find((l) => l.id === r.levelId)?.name}</div>}
                  <button onClick={() => jumpTo(r.id)} data-room={r.name}
                    className={`w-full flex justify-between rounded px-2 py-1 text-left text-xs ${selection?.id === r.id ? "bg-champagne-400/15 text-champagne-300" : pose?.roomId === r.id ? "bg-stone-800 text-stone-100" : "text-stone-300 hover:bg-stone-800/60"} ${r.inferred ? "border border-dashed border-inferred/50" : ""}`}>
                    <span className="truncate">{r.name}</span><span className="text-stone-500">{r.areaM2.toFixed(1)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5 text-xs text-stone-300">
            <div className="label">Show</div>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!showInferred} onChange={(e) => setShowInferred(!e.target.checked)} data-testid="attested-only" /> Only attested</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={miniMap} onChange={(e) => setMiniMap(e.target.checked)} /> Mini-map</label>
            {dLevel?.plan && <label className="flex items-center gap-2"><input type="checkbox" checked={overlayOn} onChange={(e) => { setOverlayOn(e.target.checked); if (e.target.checked) setMode("plan"); }} /> Source plan overlay</label>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={measuring} disabled={mode === "walk"} onChange={(e) => setMeasuring(e.target.checked)} data-testid="measure" /> Measure (click two points)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={mood === "dusk"} onChange={(e) => setMood(e.target.checked ? "dusk" : "day")} /> Dusk lighting</label>
          </div>
          {!share && sources.length > 0 && (
            <div>
              <div className="label mb-1.5">Original files</div>
              <ul className="space-y-1 text-xs">
                {sources.map((s) => <li key={s.id} className="truncate">{s.path ? <a className="text-champagne-300 hover:underline" href={fileUrl(jobId, s.path)} download>{s.name}</a> : s.url ? <a className="text-champagne-300 hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.name}</a> : s.name}</li>)}
              </ul>
            </div>
          )}
        </aside>

        <section className="relative min-h-0" data-testid="viewer">
          {showVideo && video && <WalkthroughVideo url={video} poster={fileUrl(jobId, "exports/walkthrough-poster.jpg")} onClose={() => setShowVideo(false)} />}
          {showGallery && renders && <RenderGallery jobId={jobId} index={renders} onOpenRoom={(id) => { setGallery(false); setMode("walk"); jumpTo(id); }} />}
          <Viewer3D scene={scene} jobId={jobId} mode={mode} showInferred={showInferred} levelId={mode === "walk" ? activeLevel : levelId}
            selectedId={selection?.id ?? null} pulseKey={pulse} jumpTo={jump} measuring={measuring} overlay={overlay} mood={mood} watermark
            canvasRef={canvas} onAzimuth={setAzimuth} onPose={setPose} onLockChange={setLocked}
            onSelect={(p) => { setPick(p); select(p ? { id: p.piece.elementId, kind: "piece", levelId: p.piece.levelId } : null); }}
            onRoomClick={(r) => jumpTo(r.id)} />
          {mode === "walk" && !locked && (
            <div className="absolute inset-x-0 bottom-10 flex flex-col items-center gap-2 pointer-events-none">
              <button id="walk-start" className="btn btn-gold pointer-events-auto">Click to look around</button>
              <div className="text-[11px] text-stone-300 bg-stone-950/70 rounded px-2 py-1">WASD to walk · Q/E to turn · Shift to hurry · Esc to release</div>
            </div>
          )}
          {mode === "walk" && pose && (
            <div className="absolute top-3 left-3 chip bg-stone-950/80" data-testid="walk-room">{scene.rooms.find((r) => r.id === pose.roomId)?.name ?? "—"}</div>
          )}
          <div className="absolute top-3 right-3 h-12 w-12 rounded-full border border-stone-600 bg-stone-950/70 flex items-center justify-center" title="North">
            <div style={{ transform: `rotate(${northDeg}deg)` }} className="flex flex-col items-center text-[10px] text-champagne-300 leading-none">
              <span>▲</span><span>N</span>
            </div>
          </div>
          {miniMap && <MiniMap scene={scene} levelId={activeLevel} pose={mode === "walk" ? pose : null} selectedId={selection?.id ?? null} onJump={jumpTo} />}
        </section>

        <aside className="border-l border-stone-800 p-3 space-y-3 overflow-auto scroll-thin">
          <EvidenceDrawer info={info} jobId={jobId} onClose={() => { setPick(null); select(null); }} />
          <MaterialLegend scene={scene} showInferred={showInferred} />
          {scene.warnings.length > 0 && (
            <div className="panel p-3 text-xs space-y-1">
              <div className="label">Warnings</div>
              {scene.warnings.map((w, i) => <div key={i} className="text-inferred">⚠ {w}</div>)}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function MaterialLegend({ scene, showInferred }: { scene: PropertySceneGraph; showInferred: boolean }) {
  const used = useMemo(() => {
    const ids = new Set(scene.pieces.filter((p) => showInferred || !p.inferred).map((p) => p.materialId));
    return scene.materials.filter((m) => ids.has(m.id));
  }, [scene, showInferred]);
  return (
    <div className="panel p-3 space-y-1.5">
      <div className="label">Finishes in the model</div>
      {used.map((m) => (
        <div key={m.id} className="flex items-center gap-2 text-xs">
          <span className="h-3.5 w-3.5 rounded-sm border border-stone-600" style={{ background: m.color, opacity: m.opacity }} />
          <span className="text-stone-200 truncate">{m.name}</span>
          {m.inferred && <span className="ml-auto chip chip-inferred">inferred</span>}
        </div>
      ))}
    </div>
  );
}

function MiniMap({ scene, levelId, pose, selectedId, onJump }: { scene: PropertySceneGraph; levelId: string; pose: WalkPose | null; selectedId: string | null; onJump: (id: string) => void }) {
  const rooms = scene.rooms.filter((r) => r.levelId === levelId && r.polygon.length >= 3);
  if (!rooms.length) return null;
  const xs = rooms.flatMap((r) => r.polygon.map((p) => p.x)), ys = rooms.flatMap((r) => r.polygon.map((p) => -p.y));
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const pad = Math.max(w, h) * 0.05;
  return (
    <svg className="absolute bottom-3 right-3 w-48 rounded-md border border-stone-700 bg-stone-950/80" viewBox={`${x0 - pad} ${y0 - pad} ${w + 2 * pad} ${h + 2 * pad}`} data-testid="minimap">
      {rooms.map((r) => (
        <polygon key={r.id} points={r.polygon.map((p) => `${p.x},${-p.y}`).join(" ")} onClick={() => onJump(r.id)} className="cursor-pointer"
          fill={r.id === selectedId ? "#d8bf8a55" : pose?.roomId === r.id ? "#ffffff22" : "#ffffff0a"} stroke={r.inferred ? "#e0a84a" : "#a39a8a"} strokeWidth={Math.max(w, h) / 150}
          strokeDasharray={r.inferred ? `${Math.max(w, h) / 60}` : undefined}>
          <title>{r.name}</title>
        </polygon>
      ))}
      {pose && (
        <g transform={`translate(${pose.x} ${pose.z}) rotate(${-pose.yawDeg})`}>
          <circle r={Math.max(w, h) / 45} fill="#d8bf8a" />
          <path d={`M0 0 L${-Math.max(w, h) / 30} ${-Math.max(w, h) / 12} L${Math.max(w, h) / 30} ${-Math.max(w, h) / 12} Z`} fill="#d8bf8a88" />
        </g>
      )}
    </svg>
  );
}
