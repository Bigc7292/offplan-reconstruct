"use client";
// Evidence chips, the source page viewer, and the "why is this here?" drawer.
import { Fragment, useMemo } from "react";
import type { Asset, Evidence, Material, PropertyDossier, PropertySceneGraph } from "@/lib/schema";
import { INFERRED_PREFIX, isInferred } from "@/lib/schema";
import { fileUrl, useStudio } from "@/lib/client-store";

export const pageOfRef = (ref: string) => (/^page-(\d+)$/.test(ref) ? Number(ref.slice(5)) : undefined);

export function EvidenceList({ evidence, dossier, jobId, compact }: { evidence: Evidence[]; dossier?: PropertyDossier | null; jobId: string; compact?: boolean }) {
  const focusPage = useStudio((s) => s.focusPage);
  if (!evidence.length) return <div className="text-xs text-inferred">No evidence: inferred default.</div>;
  // the same page and quote cited twice (e.g. a room read from two passes over one plan) shows once
  const seen = new Set<string>();
  const rows = evidence.filter((e) => { const k = `${e.ref}|${(e.quote ?? "").slice(0, 80)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return (
    <ul className="space-y-1.5">
      {rows.map((e, i) => {
        const inferred = e.ref.startsWith(INFERRED_PREFIX);
        const page = pageOfRef(e.ref);
        const asset = dossier?.assets.find((a) => a.id === e.ref);
        return (
          <li key={i} className={`rounded-md border px-2 py-1.5 text-xs ${inferred ? "border-dashed border-inferred/60" : "border-stone-700"}`}>
            <div className="flex items-center gap-2">
              <span className={`chip ${inferred ? "chip-inferred" : ""}`}>{inferred ? "inferred" : e.source}</span>
              <span className="text-stone-300 truncate">{inferred ? e.ref.slice(INFERRED_PREFIX.length) : e.ref}</span>
              <span className="ml-auto text-stone-500">{Math.round(e.confidence * 100)}%</span>
              {page !== undefined && (
                <button className="text-champagne-300 hover:underline" onClick={() => focusPage({ page, bbox: e.bbox })}>open p{page}</button>
              )}
            </div>
            {e.quote && !compact && <div className="mt-1 text-stone-400 italic line-clamp-3">“{e.quote}”</div>}
            {asset && <AssetThumb asset={asset} jobId={jobId} />}
          </li>
        );
      })}
    </ul>
  );
}

export function AssetThumb({ asset, jobId }: { asset: Asset; jobId: string }) {
  const focusPage = useStudio((s) => s.focusPage);
  return (
    <button className="mt-1.5 block w-full text-left" onClick={() => asset.page && focusPage({ page: asset.page })} title={asset.caption}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={fileUrl(jobId, asset.path)} alt={asset.caption ?? asset.kind} className="h-24 w-full rounded object-cover border border-stone-700" />
      <div className="mt-0.5 text-[10px] text-stone-400 truncate">{asset.kind.replace("_", " ")}{asset.caption ? ` · ${asset.caption}` : ""}{asset.page ? ` · p${asset.page}` : ""}</div>
    </button>
  );
}

/** Page image with the evidence bbox highlighted. */
export function SourcePageViewer() {
  const { job, pageFocus, focusPage } = useStudio();
  if (!job) return null;
  const n = pageFocus?.page ?? job.pages[0]?.n;
  const page = job.pages.find((p) => p.n === n);
  if (!page) return <div className="panel p-4 text-sm text-stone-400">No page selected.</div>;
  const src = job.sources.find((s) => s.id === page.sourceId);
  const bb = pageFocus?.page === page.n ? pageFocus.bbox : undefined;
  return (
    <div className="panel p-3 space-y-2" data-testid="source-page">
      <div className="flex items-center gap-2 text-xs">
        <button className="btn !px-2 !py-0.5" disabled={page.n <= 1} onClick={() => focusPage({ page: page.n - 1 })}>‹</button>
        <span className="text-stone-200">Page {page.n}</span>
        <button className="btn !px-2 !py-0.5" disabled={page.n >= job.pages.length} onClick={() => focusPage({ page: page.n + 1 })}>›</button>
        <span className="truncate text-stone-500" title={src?.name}>{src?.name} p{page.sourcePage}</span>
        {src?.path && <a className="ml-auto text-champagne-300 hover:underline shrink-0" href={fileUrl(job.id, src.path)} download>original</a>}
      </div>
      <div className="flex flex-wrap gap-1">
        {page.labels.map((l) => <span key={l} className="chip">{l.replace("_", " ")}</span>)}
        <span className="text-[10px] text-stone-500 self-center" title={page.labelReason}>{Math.round(page.labelConfidence * 100)}% · {page.textSource}</span>
      </div>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fileUrl(job.id, page.image)} alt={`Page ${page.n}`} className="w-full rounded border border-stone-800" />
        {bb && (
          <div className="absolute border-2 border-champagne-400 bg-champagne-400/15 pulse-gold rounded-sm pointer-events-none"
            style={{ left: `${bb[0] * 100}%`, top: `${bb[1] * 100}%`, width: `${(bb[2] - bb[0]) * 100}%`, height: `${(bb[3] - bb[1]) * 100}%` }} />
        )}
      </div>
      {page.caption && <div className="text-xs text-stone-400">Caption: {page.caption}</div>}
    </div>
  );
}

export type ElementInfo = {
  title: string;
  subtitle: string;
  inferred: boolean;
  evidence: Evidence[];
  material?: Material;
  materialInferred?: boolean;
  materialAssets: Asset[];
  facts: Array<[string, string]>;
};

/** Resolve a picked scene element (or a dossier id) back to the dossier and its evidence. */
export function describeElement(d: PropertyDossier, g: PropertySceneGraph | null, elementId: string, pieceKind?: string, materialId?: string): ElementInfo | null {
  const mat = (id?: string) => d.materials.find((m) => m.id === id);
  const assetsOf = (m?: Material) => (m ? [...new Set([m.textureAssetId, ...m.mapsFromAssetIds].filter(Boolean) as string[])].map((id) => d.assets.find((a) => a.id === id)).filter(Boolean) as Asset[] : []);
  const sceneMat = g?.materials.find((m) => m.id === materialId);
  for (const l of d.levels) {
    const room = l.rooms.find((r) => r.id === elementId);
    if (room) {
      const sr = g?.rooms.find((r) => r.id === room.id);
      const m = mat(pieceKind === "ceiling" ? materialId : (materialId ?? sr?.floorMaterialId));
      return {
        title: room.name,
        subtitle: `${pieceKind ?? "room"} · ${room.program} · ${l.name}`,
        inferred: isInferred(room.evidence),
        evidence: room.evidence,
        material: m,
        materialInferred: m ? isInferred(m.evidence) : sceneMat?.inferred,
        materialAssets: assetsOf(m),
        facts: [
          ["Area", sr ? `${sr.areaM2.toFixed(2)} m²${sr.documentedAreaM2 ? " (documented)" : " (computed)"}` : "—"],
          ...(sr?.documentedAreaM2 ? [["Computed", `${sr.computedAreaM2.toFixed(2)} m²`] as [string, string]] : []),
          ["Ceiling", sr ? `${sr.ceilingHeightM.toFixed(2)} m${sr.ceilingInferred ? " (inferred)" : ""}` : "—"],
          ["Material", m?.name ?? sceneMat?.name ?? "—"],
        ],
      };
    }
    for (const w of l.walls) {
      const o = w.openings.find((x) => x.id === elementId);
      if (o || w.id === elementId) {
        const m = mat(materialId ?? w.materialId);
        const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
        return {
          title: o ? `${o.kind.replace("_", " ")} in ${w.id}` : `${w.kind} wall ${w.id}`,
          subtitle: `${pieceKind ?? (o ? "opening" : "wall")} · ${l.name}`,
          inferred: isInferred(o ? o.evidence : w.evidence),
          evidence: o ? o.evidence : w.evidence,
          material: m,
          materialInferred: m ? isInferred(m.evidence) : sceneMat?.inferred,
          materialAssets: assetsOf(m),
          facts: o
            ? [["Width", `${o.widthM.toFixed(2)} m`], ["Height", `${o.heightM.toFixed(2)} m`], ...(o.sillM ? [["Sill", `${o.sillM.toFixed(2)} m`] as [string, string]] : [])]
            : [["Length", `${len.toFixed(2)} m`], ["Thickness", `${w.thicknessM.toFixed(2)} m`], ["Height", `${w.heightM.toFixed(2)} m`], ["Material", m?.name ?? sceneMat?.name ?? "—"]],
        };
      }
    }
    const f = l.furniture?.find((x) => x.id === elementId);
    if (f) return { title: f.kind.replace("_", " "), subtitle: `furniture proxy · ${l.name}`, inferred: isInferred(f.evidence), evidence: f.evidence, materialAssets: [], facts: [["Size", `${f.sizeM.w}×${f.sizeM.d}×${f.sizeM.h} m`]] };
  }
  const m = mat(elementId);
  if (m) return { title: m.name, subtitle: `material · ${m.appliedTo.join(", ")}`, inferred: isInferred(m.evidence), evidence: m.evidence, material: m, materialInferred: isInferred(m.evidence), materialAssets: assetsOf(m), facts: [["Albedo", m.albedoHint], ["Roughness", String(m.roughness)]] };
  return null;
}

export function EvidenceDrawer({ info, jobId, onClose }: { info: ElementInfo | null; jobId: string; onClose?: () => void }) {
  const dossier = useStudio((s) => s.dossier);
  const body = useMemo(() => info, [info]);
  if (!body) return <div className="panel p-4 text-sm text-stone-400">Click any wall, floor or finish to see which page or render justifies it.</div>;
  return (
    <div className="panel p-4 space-y-3" data-testid="evidence-drawer">
      <div className="flex items-start gap-2">
        <div>
          <div className="text-stone-100 capitalize">{body.title}</div>
          <div className="text-[11px] text-stone-400">{body.subtitle}</div>
        </div>
        <span className={`ml-auto chip ${body.inferred ? "chip-inferred" : "chip-gold"}`}>{body.inferred ? "inferred" : "attested"}</span>
        {onClose && <button className="text-stone-500 hover:text-stone-200" onClick={onClose} aria-label="Close">×</button>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {body.facts.map(([k, v]) => (<Fragment key={k}><dt className="text-stone-500">{k}</dt><dd className="text-stone-200">{v}</dd></Fragment>))}
      </dl>
      <div>
        <div className="label mb-1">Geometry evidence</div>
        <EvidenceList evidence={body.evidence} dossier={dossier} jobId={jobId} />
      </div>
      {body.material && (
        <div>
          <div className="label mb-1 flex items-center gap-2">
            Finish: <span className="normal-case tracking-normal text-stone-200">{body.material.name}</span>
            <span className="inline-block h-3 w-3 rounded-sm border border-stone-600" style={{ background: /^#/.test(body.material.albedoHint) ? body.material.albedoHint : undefined }} />
            {body.materialInferred && <span className="chip chip-inferred">inferred</span>}
          </div>
          {body.materialAssets.map((a) => <AssetThumb key={a.id} asset={a} jobId={jobId} />)}
          <div className="mt-1"><EvidenceList evidence={body.material.evidence} dossier={dossier} jobId={jobId} /></div>
        </div>
      )}
    </div>
  );
}
