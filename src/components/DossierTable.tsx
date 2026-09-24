"use client";
// The review table: facts, rooms, walls, materials and warnings. Clicking a row selects the
// element (pulsing it in 2D and 3D) and opens the page that justifies it.
import { useState } from "react";
import type { Evidence, PropertyDossier } from "@/lib/schema";
import { isInferred } from "@/lib/schema";
import { dist, polygonArea } from "@/lib/geom";
import { setWallLength, updateRoom } from "@/lib/plan-edit";
import { useStudio } from "@/lib/client-store";
import { pageOfRef } from "./Evidence";

type Tab = "facts" | "rooms" | "walls" | "materials" | "warnings";

export function DossierTable({ dossier, attestedOnly }: { dossier: PropertyDossier; attestedOnly: boolean }) {
  const { selection, select, focusPage, editLevel, editDossier, levelId } = useStudio();
  const [tab, setTab] = useState<Tab>("rooms");
  const level = dossier.levels.find((l) => l.id === levelId) ?? dossier.levels[0];
  const openEv = (ev: Evidence[]) => {
    const e = ev.find((x) => pageOfRef(x.ref) !== undefined);
    if (e) focusPage({ page: pageOfRef(e.ref)!, bbox: e.bbox });
  };
  const tabs: Array<[Tab, string, number]> = [
    ["facts", "Facts", dossier.facts.length],
    ["rooms", "Rooms", level?.rooms.length ?? 0],
    ["walls", "Walls", level?.walls.length ?? 0],
    ["materials", "Finishes", dossier.materials.length],
    ["warnings", "Warnings", dossier.warnings.length],
  ];
  return (
    <div className="panel flex flex-col min-h-0" data-testid="dossier-table">
      <div className="flex gap-1 border-b border-stone-800 px-2 pt-2">
        {tabs.map(([t, label, n]) => (
          <button key={t} onClick={() => setTab(t)} className={`px-2.5 py-1.5 text-xs rounded-t ${tab === t ? "bg-stone-800 text-champagne-300" : "text-stone-400 hover:text-stone-200"}`}>
            {label} <span className="text-stone-500">{n}</span>
          </button>
        ))}
      </div>
      <div className="overflow-auto scroll-thin max-h-[560px] text-xs">
        {tab === "facts" && (
          <table className="w-full">
            <tbody>
              {dossier.facts.map((f, i) => (
                <tr key={i} className="border-b border-stone-800/70 hover:bg-stone-800/40 cursor-pointer" onClick={() => openEv(f.evidence)}>
                  <td className="px-3 py-1.5 text-stone-400 whitespace-nowrap align-top">{f.key}</td>
                  <td className="px-3 py-1.5 text-stone-100">{f.value}</td>
                  <td className="px-3 py-1.5 text-stone-500 whitespace-nowrap align-top">{f.evidence.map((e) => e.ref).join(", ")}</td>
                </tr>
              ))}
              {!dossier.facts.length && <tr><td className="p-4 text-stone-500">No facts extracted.</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "rooms" && level && (
          <table className="w-full">
            <thead className="text-stone-500 text-left">
              <tr><th className="px-3 py-1.5 font-normal">Room</th><th className="px-2 font-normal">Program</th><th className="px-2 font-normal text-right">Printed m²</th><th className="px-2 font-normal text-right">Traced m²</th><th className="px-2 font-normal">Source</th></tr>
            </thead>
            <tbody>
              {level.rooms.filter((r) => !attestedOnly || !isInferred(r.evidence)).map((r) => {
                const traced = r.polygon.length >= 3 ? polygonArea(r.polygon) : undefined;
                const off = r.areaM2 && traced ? Math.abs(traced - r.areaM2) / r.areaM2 > 0.1 : false;
                const inf = isInferred(r.evidence);
                return (
                  <tr key={r.id} data-room={r.name} className={`border-b border-stone-800/70 cursor-pointer ${selection?.id === r.id ? "bg-champagne-400/10" : "hover:bg-stone-800/40"}`}
                    onClick={() => { select({ id: r.id, kind: "room", levelId: level.id }, true); openEv(r.evidence); }}>
                    <td className="px-3 py-1.5">
                      <input className="bg-transparent text-stone-100 w-full outline-none focus:text-champagne-300" value={r.name}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => editLevel(level.id, (l) => updateRoom(l, r.id, { name: e.target.value }, `renamed room to ${e.target.value}`))} />
                    </td>
                    <td className="px-2 text-stone-400">{r.program}</td>
                    <td className="px-2 text-right text-stone-200">{r.areaM2?.toFixed(2) ?? "—"}</td>
                    <td className={`px-2 text-right ${off ? "text-danger" : "text-stone-400"}`} title={off ? "Traced area differs from the printed area by more than 10%" : ""}>{traced?.toFixed(2) ?? <span className="text-inferred">unplaced</span>}</td>
                    <td className="px-2">{inf ? <span className="chip chip-inferred">inferred</span> : <span className="text-stone-500 whitespace-nowrap">{r.evidence.map((e) => e.ref).filter((x, i, a) => a.indexOf(x) === i).join(", ")}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === "walls" && level && (
          <table className="w-full">
            <thead className="text-stone-500 text-left">
              <tr><th className="px-3 py-1.5 font-normal">Wall</th><th className="px-2 font-normal">Kind</th><th className="px-2 font-normal text-right">Length m</th><th className="px-2 font-normal text-right">Thick</th><th className="px-2 font-normal">Openings</th><th className="px-2 font-normal">Source</th></tr>
            </thead>
            <tbody>
              {level.walls.filter((w) => !attestedOnly || !isInferred(w.evidence)).map((w) => (
                <tr key={w.id} data-wall={w.id} className={`border-b border-stone-800/70 cursor-pointer ${selection?.id === w.id ? "bg-champagne-400/10" : "hover:bg-stone-800/40"}`}
                  onClick={() => { select({ id: w.id, kind: "wall", levelId: level.id }, true); openEv(w.evidence); }}>
                  <td className="px-3 py-1.5 text-stone-300">{w.id}</td>
                  <td className="px-2 text-stone-400">{w.kind}</td>
                  <td className="px-2 text-right">
                    <LengthInput value={dist(w.a, w.b)} onCommit={(v) => editLevel(level.id, (l) => setWallLength(l, w.id, v))} />
                  </td>
                  <td className="px-2 text-right text-stone-400">{w.thicknessM.toFixed(2)}</td>
                  <td className="px-2 text-stone-400">{w.openings.map((o) => o.kind.replace("_", " ")).join(", ") || "—"}</td>
                  <td className="px-2">{isInferred(w.evidence) ? <span className="chip chip-inferred">inferred</span> : <span className="text-stone-500 whitespace-nowrap">{[...new Set(w.evidence.map((e) => e.ref))].join(", ")}</span>}</td>
                </tr>
              ))}
              {!level.walls.length && <tr><td className="p-4 text-stone-500" colSpan={6}>No walls yet. Trace rooms in the plan editor, then use “Walls from rooms”.</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "materials" && (
          <table className="w-full">
            <tbody>
              {dossier.materials.map((m) => (
                <tr key={m.id} className={`border-b border-stone-800/70 cursor-pointer ${selection?.id === m.id ? "bg-champagne-400/10" : "hover:bg-stone-800/40"}`} onClick={() => { select({ id: m.id, kind: "material" }, true); openEv(m.evidence); }}>
                  <td className="px-3 py-1.5"><span className="inline-block h-4 w-4 rounded border border-stone-600 align-middle" style={{ background: /^#/.test(m.albedoHint) ? m.albedoHint : "#777" }} /></td>
                  <td className="px-2 text-stone-100">{m.name}</td>
                  <td className="px-2 text-stone-400">{m.appliedTo.join(", ")}{m.programs?.length ? ` · ${m.programs.join(", ")}` : ""}</td>
                  <td className="px-2">{isInferred(m.evidence) ? <span className="chip chip-inferred">inferred</span> : <span className="text-stone-500">{[...new Set(m.evidence.map((e) => e.ref))].join(", ")}</span>}</td>
                  <td className="px-2">
                    <button className="text-stone-500 hover:text-danger" title="Remove this finish" onClick={(e) => { e.stopPropagation(); editDossier((d) => ({ ...d, materials: d.materials.filter((x) => x.id !== m.id) })); }}>×</button>
                  </td>
                </tr>
              ))}
              {!dossier.materials.length && <tr><td className="p-4 text-stone-500">No finishes found; neutral defaults will be used and marked inferred.</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "warnings" && (
          <ul className="p-3 space-y-1.5">
            {dossier.warnings.map((w, i) => <li key={i} className="text-inferred">⚠ {w}</li>)}
            {!dossier.warnings.length && <li className="text-stone-500">No warnings.</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function LengthInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    const v = Number(text);
    if (text !== null && Number.isFinite(v) && v > 0.05 && Math.abs(v - value) > 1e-4) onCommit(v);
    setText(null);
  };
  return (
    <input
      className="w-16 bg-stone-950/60 rounded px-1 text-right text-stone-100 outline-none focus:ring-1 focus:ring-champagne-400"
      value={text ?? value.toFixed(2)}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setText(null); }}
      data-testid="wall-length"
    />
  );
}
