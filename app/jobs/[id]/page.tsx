"use client";
// Review: pipeline progress, every page classified, the dossier table beside its source page,
// the 2D plan editor, and a live 3D preview once the model has been generated.
import { use, useState } from "react";
import Link from "next/link";
import { Brand, Footer } from "@/components/Brand";
import { PipelineStepper } from "@/components/PipelineStepper";
import { PageFilmstrip } from "@/components/PageFilmstrip";
import { DossierTable } from "@/components/DossierTable";
import { PlanEditor2D } from "@/components/PlanEditor2D";
import { SourcePageViewer, EvidenceDrawer, describeElement } from "@/components/Evidence";
import { Viewer3D } from "@/components/ViewerDynamic";
import { useStudio } from "@/lib/client-store";
import { useJobPolling } from "@/lib/use-job";
import { levelsForSelection } from "@/lib/selection";
import type { PickInfo } from "@/scene/UnitMesh";

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  useJobPolling(id);
  const { job, dossier, scene, logs, dirty, saving, saveError, selection, pulse, pageFocus, levelId, focusPage, setLevel, editDossier, select, reconstruct, save } = useStudio();
  const [attestedOnly, setAttestedOnly] = useState(false);
  const [building, setBuilding] = useState(false);
  const [pick, setPick] = useState<PickInfo | null>(null);

  if (!job) return <main className="min-h-screen flex items-center justify-center text-stone-500">Loading job…</main>;
  const selectedLevels = dossier ? levelsForSelection(dossier) : [];
  const level = dossier?.levels.find((l) => l.id === levelId) ?? selectedLevels[0] ?? dossier?.levels[0];
  const inReview = !!dossier && job.stages.find((s) => s.name === "extract")?.status === "done";

  const generate = async () => {
    setBuilding(true);
    if (dirty) await save();
    await reconstruct();
    setBuilding(false);
  };
  const info = dossier && pick ? describeElement(dossier, scene, pick.piece.elementId, pick.piece.elementKind, pick.piece.materialId) : dossier && selection ? describeElement(dossier, scene, selection.id) : null;

  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-6 py-4 flex items-center gap-4 border-b border-stone-800">
        <Brand small />
        <div className="min-w-0">
          <div className="truncate text-stone-100">{dossier?.projectName ?? job.title}</div>
          <div className="text-[11px] text-stone-500">{job.sources.map((s) => s.name).join(" · ")}</div>
        </div>
        {job.demo && <span className="chip chip-inferred">DEMO</span>}
        <span className="chip">{job.extractorLabel ?? (job.extractor === "local" ? "local extractor" : job.extractor)}</span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className={saveError ? "text-danger" : "text-stone-500"} data-testid="save-state">{saveError || (saving ? "Saving…" : dirty ? "Unsaved" : "Saved")}</span>
          <label className="flex items-center gap-1.5 text-stone-300">
            <input type="checkbox" checked={attestedOnly} onChange={(e) => setAttestedOnly(e.target.checked)} /> Only attested
          </label>
          {scene && <Link className="btn btn-gold" href={`/jobs/${id}/model`}>Open walkthrough</Link>}
        </div>
      </header>

      <div className="flex-1 px-6 py-5 space-y-4">
        <PipelineStepper job={job} logs={logs} />
        <PageFilmstrip job={job} active={pageFocus?.page} onPick={(n) => focusPage({ page: n })} />

        {job.sources.filter((s) => s.status !== "ok").map((s) => (
          <div key={s.id} className="panel p-3 text-sm text-danger">Source “{s.name}” {s.status}: {s.error}</div>
        ))}

        {dossier && (
          <>
            <div className="panel p-3 flex flex-wrap items-center gap-3 text-sm">
              <span className="label">Unit type</span>
              {dossier.unitTypes.map((u) => (
                <button key={u.id} data-testid="unit-type"
                  className={`chip ${dossier.selectedUnitTypeId === u.id ? "chip-gold" : ""}`}
                  onClick={() => { editDossier((d) => ({ ...d, selectedUnitTypeId: u.id })); const first = dossier.levels.find((l) => u.levelIds.includes(l.id)); if (first) setLevel(first.id); }}>
                  {dossier.selectedUnitTypeId === u.id ? "✓ " : "Use this unit type: "}{u.code}
                  {u.beds ? ` · ${u.beds} bed` : ""}{u.totalAreaM2 ? ` · ${u.totalAreaM2} m²` : u.suiteAreaM2 ? ` · ${u.suiteAreaM2} m²` : ""}
                </button>
              ))}
              {!dossier.unitTypes.length && <span className="text-stone-500">No unit types found.</span>}
              <span className="label ml-4">Level</span>
              {dossier.levels.map((l) => (
                <button key={l.id} data-testid="level-tab" onClick={() => setLevel(l.id)} className={`chip ${level?.id === l.id ? "chip-gold" : ""} ${selectedLevels.some((x) => x.id === l.id) ? "" : "opacity-50"}`}>
                  {l.name} <span className="text-stone-500">{l.rooms.length}r/{l.walls.length}w</span>
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2 text-xs text-stone-400">
                {(["hasPlan", "hasScale", "hasDimensions", "hasCgi", "hasFinishSchedule"] as const).map((k) => (
                  <span key={k} className={dossier.completeness[k] ? "text-ok" : "text-stone-600"}>{dossier.completeness[k] ? "●" : "○"} {k.slice(3).replace(/([A-Z])/g, " $1").trim()}</span>
                ))}
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1.35fr)] lg:grid-cols-2">
              <SourcePageViewer />
              <DossierTable dossier={dossier} attestedOnly={attestedOnly} />
              {level ? <PlanEditor2D jobId={id} level={level} attestedOnly={attestedOnly} /> : <div className="panel p-4 text-sm text-stone-400">No plan level found in the sources. Add a floor plan PDF or image.</div>}
            </div>

            <div className="panel p-4 flex flex-wrap items-center gap-4">
              <div className="space-y-0.5">
                <div className="text-stone-100">{scene ? "3D model is live" : "Review the dossier, then build the model"}</div>
                <div className="text-xs text-stone-400">The builder reads only the dossier above: same dossier, same model. Inferred items are tinted amber.</div>
              </div>
              <button className="btn btn-gold ml-auto" disabled={!inReview || building} onClick={generate} data-testid="generate">
                {building ? "Building…" : scene ? "Rebuild 3D model" : "Generate 3D model"}
              </button>
            </div>

            {scene && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="panel h-[520px] overflow-hidden" data-testid="preview-3d">
                  <Viewer3D scene={scene} jobId={id} mode="dollhouse" compact showInferred={!attestedOnly} levelId={level?.id ?? "all"}
                    selectedId={selection?.id ?? null} pulseKey={pulse} measuring={false} watermark
                    onSelect={(p) => { setPick(p); if (p) select({ id: p.piece.elementId, kind: "piece", levelId: p.piece.levelId }); }}
                    onRoomClick={(r) => { setPick(null); select({ id: r.id, kind: "room", levelId: r.levelId }, true); }} />
                </div>
                <EvidenceDrawer info={info} jobId={id} onClose={() => { setPick(null); select(null); }} />
              </div>
            )}
          </>
        )}
      </div>
      <Footer />
    </main>
  );
}
