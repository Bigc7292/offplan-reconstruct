"use client";
// 2D plan editor over the source plan image. Units are metres; SVG y = -plan y.
// Inferred geometry is drawn dashed. Every edit writes reviewer evidence.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Level, Opening, Room, Vec2, Wall } from "@/lib/schema";
import { isInferred } from "@/lib/schema";
import { dist, closestOnSegment, labelPoint, polygonArea, distToSegment } from "@/lib/geom";
import { addInferredDoors, addOpening, addWall, calibrate, moveJoint, removeElement, setWallLength, traceRoomRect, updateOpening, updateRoom, updateWall, wallsFromRooms } from "@/lib/plan-edit";
import { fileUrl, useStudio } from "@/lib/client-store";

type Tool = "select" | "wall" | "room" | "door" | "window" | "sliding_door" | "calibrate";
const PROGRAMS = ["bedroom", "living", "kitchen", "bath", "balcony", "circulation", "storage", "amenity", "other"];
const PROGRAM_FILL: Record<string, string> = {
  bedroom: "#8a7a62", living: "#a08a60", kitchen: "#7f8a6a", bath: "#6a8290", balcony: "#6f8a70", circulation: "#6b645a", storage: "#5f5a52", amenity: "#8a6a7a", other: "#6b645a",
};
const WALL_COLOR: Record<Wall["kind"], string> = { exterior: "#e8e2d6", interior: "#cfc6b6", partition: "#b3aa9a", glass: "#8fb4c0", railing: "#8fb4c0" };

export function PlanEditor2D({ jobId, level, attestedOnly }: { jobId: string; level: Level; attestedOnly: boolean }) {
  const { selection, select, editLevel, pulse, focusPage } = useStudio();
  const [tool, setTool] = useState<Tool>("select");
  const [draft, setDraft] = useState<Level | null>(null); // live drag preview
  const [pts, setPts] = useState<Vec2[]>([]); // pending clicks for wall/calibrate
  const [rect, setRect] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const [calDist, setCalDist] = useState("");
  const [hoverPt, setHoverPt] = useState<Vec2 | null>(null);
  const [underlay, setUnderlay] = useState(0.6);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "joint"; from: Vec2 } | { kind: "pan"; start: { x: number; y: number }; vb: number[] } | null>(null);
  const L = draft ?? level;

  // ── view box ──
  const contentBox = useMemo(() => {
    const xs: number[] = [], ys: number[] = [];
    for (const w of level.walls) xs.push(w.a.x, w.b.x), ys.push(-w.a.y, -w.b.y);
    for (const r of level.rooms) for (const p of r.polygon) xs.push(p.x), ys.push(-p.y);
    if (level.plan) {
      const p = level.plan;
      xs.push(-p.originPx.x / p.pxPerM, (p.imageW - p.originPx.x) / p.pxPerM);
      ys.push(-p.originPx.y / p.pxPerM, (p.imageH - p.originPx.y) / p.pxPerM);
    }
    if (!xs.length) return [-1, -11, 22, 12];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = Math.max(x1 - x0, y1 - y0) * 0.05 + 0.5;
    return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level.id, level.plan?.pxPerM]);
  const [vb, setVb] = useState<number[]>(contentBox);
  useEffect(() => setVb(contentBox), [contentBox]);
  const unit = vb[2] / 100; // ~1% of the view width, for handle and text sizes

  const toPlan = (e: { clientX: number; clientY: number }): Vec2 => {
    const s = svg.current!;
    const pt = s.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(s.getScreenCTM()!.inverse());
    return { x: p.x, y: -p.y };
  };
  const joints = useMemo(() => {
    const out: Vec2[] = [];
    for (const w of L.walls) for (const p of [w.a, w.b]) if (!out.some((q) => dist(p, q) < 0.02)) out.push(p);
    for (const r of L.rooms) for (const p of r.polygon) if (!out.some((q) => dist(p, q) < 0.02)) out.push(p);
    return out;
  }, [L]);
  const snap = (p: Vec2, anchor?: Vec2, ortho = true): Vec2 => {
    const j = joints.find((q) => dist(q, p) < unit * 1.2);
    if (j) return j;
    if (anchor && ortho) {
      const dx = Math.abs(p.x - anchor.x), dy = Math.abs(p.y - anchor.y);
      if (dx < dy * 0.15) return { x: anchor.x, y: p.y };
      if (dy < dx * 0.15) return { x: p.x, y: anchor.y };
    }
    return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
  };
  const nearestWall = (p: Vec2) => {
    let best: Wall | null = null, bd = Infinity;
    for (const w of L.walls) { const d = distToSegment(p, w.a, w.b); if (d < bd) { bd = d; best = w; } }
    return bd < unit * 2 ? best : null;
  };

  const commit = (fn: (l: Level) => Level) => editLevel(level.id, fn);

  // ── pointer handling ──
  const onDown = (e: React.PointerEvent) => {
    const p = toPlan(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === "room") { setRect({ a: snap(p), b: snap(p) }); return; }
    if (tool === "select" && (e.target as Element).getAttribute("data-bg") === "1") {
      drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, vb: [...vb] };
      select(null);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const p = toPlan(e);
    setHoverPt(p);
    const d = drag.current;
    if (d?.kind === "pan") {
      const s = svg.current!.getBoundingClientRect();
      const k = d.vb[2] / s.width;
      setVb([d.vb[0] - (e.clientX - d.start.x) * k, d.vb[1] - (e.clientY - d.start.y) * k, d.vb[2], d.vb[3]]);
    } else if (d?.kind === "joint") {
      setDraft(moveJoint(level, d.from, snap(p, undefined, false), "moved joint"));
    } else if (rect) {
      setRect({ ...rect, b: snap(p) });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "joint" && draft) {
      const to = snap(toPlan(e), undefined, false);
      commit((l) => moveJoint(l, d.from, to, `moved joint to (${to.x.toFixed(2)}, ${to.y.toFixed(2)})`));
      setDraft(null);
    }
    if (rect) {
      if (dist(rect.a, rect.b) > 0.3) {
        const target = selection?.kind === "room" && selection.levelId === level.id ? selection.id : null;
        const unplaced = level.rooms.find((r) => r.id === target);
        const name = unplaced?.name ?? `Room ${level.rooms.length + 1}`;
        let newId = "";
        commit((l) => { const out = traceRoomRect(l, target, rect.a, rect.b, name); newId = out.roomId; return out.level; });
        setTimeout(() => select({ id: newId, kind: "room", levelId: level.id }), 0);
      }
      setRect(null);
    }
  };
  const onClick = (e: React.MouseEvent) => {
    const p = toPlan(e);
    if (tool === "wall") {
      const q = snap(p, pts[0]);
      if (!pts.length) setPts([q]);
      else { commit((l) => addWall(l, pts[0], q, "interior")); setPts([q]); }
    } else if (tool === "door" || tool === "window" || tool === "sliding_door") {
      const w = nearestWall(p);
      if (w) commit((l) => addOpening(l, w.id, p, tool));
    } else if (tool === "calibrate") {
      if (pts.length >= 2) setPts([p]);
      else setPts([...pts, p]);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toPlan(e);
    const k = Math.exp(e.deltaY * 0.0015);
    const [x, y, w, h] = vb;
    const px = p.x, py = -p.y;
    setVb([px - (px - x) * k, py - (py - y) * k, w * k, h * k]);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      if (e.key === "Escape") { setPts([]); setRect(null); setTool("select"); }
      if ((e.key === "Delete" || e.key === "Backspace") && selection && selection.levelId === level.id) {
        commit((l) => removeElement(l, selection.id));
        select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selWall = selection?.kind === "wall" ? L.walls.find((w) => w.id === selection.id) : undefined;
  const selRoom = selection?.kind === "room" ? L.rooms.find((r) => r.id === selection.id) : undefined;
  const selOpening = selection?.kind === "opening" ? L.walls.flatMap((w) => w.openings).find((o) => o.id === selection.id) : undefined;
  const unplaced = L.rooms.filter((r) => r.polygon.length < 3);
  const plan = L.plan;
  const pageN = Number(level.id.match(/^L-p(\d+)/)?.[1]) || undefined;

  const showEv = (evs: { ref: string; bbox?: [number, number, number, number] }[]) => {
    const e = evs.find((x) => /^page-\d+$/.test(x.ref));
    if (e) focusPage({ page: Number(e.ref.slice(5)), bbox: e.bbox });
  };

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex flex-wrap items-center gap-1">
        {([
          ["select", "Select"], ["room", "Trace room"], ["wall", "Wall"], ["door", "Door"], ["window", "Window"], ["sliding_door", "Slider"], ["calibrate", "Calibrate scale"],
        ] as Array<[Tool, string]>).map(([t, label]) => (
          <button key={t} className={`btn !px-2 !py-1 !text-xs ${tool === t ? "!border-champagne-400 !text-champagne-300" : ""}`} onClick={() => { setTool(t); setPts([]); }}>{label}</button>
        ))}
        <span className="mx-1 h-4 w-px bg-stone-700" />
        <button className="btn !px-2 !py-1 !text-xs" title="Create walls along the traced room outlines (no doors are invented)" onClick={() => commit(wallsFromRooms)} disabled={!L.rooms.some((r) => r.polygon.length >= 3)}>Walls from rooms</button>
        <button className="btn !px-2 !py-1 !text-xs !border-dashed !border-inferred !text-inferred" title="Adds a 0.9 m opening mid-wall on interior walls without one, flagged as inferred" onClick={() => commit(addInferredDoors)} disabled={!L.walls.length}>Add inferred doors</button>
        {plan && (
          <label className="ml-auto flex items-center gap-2 text-[11px] text-stone-400">
            plan <input type="range" min={0} max={1} step={0.05} value={underlay} onChange={(e) => setUnderlay(Number(e.target.value))} />
          </label>
        )}
      </div>

      {plan && plan.scaleConfidence < 0.5 && (
        <div className="rounded-md border border-dashed border-inferred px-3 py-2 text-xs text-inferred">
          Scale not proven for this plan. Use <b>Calibrate scale</b>: click both ends of a printed dimension, then enter its length (e.g. a room printed “4.2 X 2.4”).
        </div>
      )}
      {unplaced.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="label mr-1">Listed, not yet placed</span>
          {unplaced.map((r) => (
            <button key={r.id} onClick={() => { select({ id: r.id, kind: "room", levelId: level.id }); setTool("room"); showEv(r.evidence); }} className={`chip chip-inferred ${selection?.id === r.id ? "!text-stone-950 !bg-inferred" : ""}`}>{r.name}</button>
          ))}
          <span className="text-stone-500 ml-1">select one, then drag its outline on the plan</span>
        </div>
      )}

      <div className="relative flex-1 min-h-[340px] rounded-lg border border-stone-700 bg-stone-950 overflow-hidden">
        <svg
          ref={svg}
          viewBox={vb.join(" ")}
          className={`h-full w-full touch-none select-none ${tool === "select" ? "cursor-grab" : "cursor-crosshair"}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onClick={onClick}
          onWheel={onWheel}
        >
          <rect data-bg="1" x={vb[0] - vb[2]} y={vb[1] - vb[3]} width={vb[2] * 3} height={vb[3] * 3} fill="transparent" />
          {plan && (
            <image
              href={fileUrl(jobId, plan.imagePath)}
              x={-plan.originPx.x / plan.pxPerM}
              y={-plan.originPx.y / plan.pxPerM}
              width={plan.imageW / plan.pxPerM}
              height={plan.imageH / plan.pxPerM}
              opacity={underlay}
              preserveAspectRatio="none"
              pointerEvents="none"
            />
          )}
          {/* rooms */}
          {L.rooms.filter((r) => r.polygon.length >= 3 && (!attestedOnly || !isInferred(r.evidence))).map((r) => {
            const inf = isInferred(r.evidence);
            const sel = selection?.id === r.id;
            const lp = labelPoint(r.polygon);
            const area = polygonArea(r.polygon);
            return (
              <g key={r.id} onClick={(e) => { if (tool !== "select") return; e.stopPropagation(); select({ id: r.id, kind: "room", levelId: level.id }); showEv(r.evidence); }}>
                <polygon
                  points={r.polygon.map((p) => `${p.x},${-p.y}`).join(" ")}
                  fill={PROGRAM_FILL[r.program] ?? "#6b645a"}
                  fillOpacity={sel ? 0.45 : 0.22}
                  stroke={sel ? "#e6d3a8" : inf ? "#d9a441" : "#b5ad9f"}
                  strokeWidth={unit * (sel ? 0.35 : 0.18)}
                  strokeDasharray={inf ? `${unit} ${unit * 0.6}` : undefined}
                />
                <text x={lp.x} y={-lp.y} textAnchor="middle" fontSize={unit * 1.5} fill="#ede8df" pointerEvents="none">{r.name}</text>
                <text x={lp.x} y={-lp.y + unit * 1.9} textAnchor="middle" fontSize={unit * 1.2} fill="#b5ad9f" pointerEvents="none">
                  {(r.areaM2 ?? area).toFixed(1)} m²{r.areaM2 !== undefined && Math.abs(r.areaM2 - area) > 0.5 ? ` (traced ${area.toFixed(1)})` : ""}
                </text>
              </g>
            );
          })}
          {/* walls + openings */}
          {L.walls.filter((w) => !attestedOnly || !isInferred(w.evidence)).map((w) => {
            const inf = isInferred(w.evidence);
            const sel = selection?.id === w.id;
            const len = dist(w.a, w.b);
            return (
              <g key={w.id} onClick={(e) => { if (tool !== "select") return; e.stopPropagation(); select({ id: w.id, kind: "wall", levelId: level.id }); showEv(w.evidence); }}>
                <line x1={w.a.x} y1={-w.a.y} x2={w.b.x} y2={-w.b.y} stroke={sel ? "#e6d3a8" : WALL_COLOR[w.kind]} strokeWidth={Math.max(w.thicknessM, unit * 0.4)} strokeLinecap="square" strokeDasharray={inf ? `${unit * 0.8} ${unit * 0.5}` : undefined} opacity={w.kind === "glass" || w.kind === "railing" ? 0.8 : 1}>
                  {sel && <animate key={pulse} attributeName="stroke-opacity" values="1;0.2;1;0.2;1" dur="1.2s" repeatCount="1" />}
                </line>
                <line x1={w.a.x} y1={-w.a.y} x2={w.b.x} y2={-w.b.y} stroke="transparent" strokeWidth={unit * 2} />
                {w.openings.map((o) => <OpeningMark key={o.id} w={w} o={o} unit={unit} selected={selection?.id === o.id} onPick={() => { select({ id: o.id, kind: "opening", levelId: level.id }); showEv(o.evidence); }} />)}
                {sel && (
                  <text x={(w.a.x + w.b.x) / 2} y={-(w.a.y + w.b.y) / 2 - unit * 1.2} textAnchor="middle" fontSize={unit * 1.4} fill="#e6d3a8" pointerEvents="none">{len.toFixed(2)} m</text>
                )}
              </g>
            );
          })}
          {/* joints (drag to move) */}
          {tool === "select" && joints.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={-p.y}
              r={unit * 0.55}
              fill="#171513"
              stroke="#d4bb86"
              strokeWidth={unit * 0.15}
              className="cursor-move"
              onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); drag.current = { kind: "joint", from: p }; }}
            />
          ))}
          {/* pending wall / calibration / room rect */}
          {tool === "wall" && pts[0] && hoverPt && <line x1={pts[0].x} y1={-pts[0].y} x2={snap(hoverPt, pts[0]).x} y2={-snap(hoverPt, pts[0]).y} stroke="#e6d3a8" strokeWidth={unit * 0.3} strokeDasharray={`${unit} ${unit / 2}`} />}
          {tool === "calibrate" && pts.map((p, i) => <circle key={i} cx={p.x} cy={-p.y} r={unit * 0.6} fill="#e6d3a8" />)}
          {tool === "calibrate" && pts.length === 2 && <line x1={pts[0].x} y1={-pts[0].y} x2={pts[1].x} y2={-pts[1].y} stroke="#e6d3a8" strokeWidth={unit * 0.25} />}
          {rect && <rect x={Math.min(rect.a.x, rect.b.x)} y={-Math.max(rect.a.y, rect.b.y)} width={Math.abs(rect.b.x - rect.a.x)} height={Math.abs(rect.b.y - rect.a.y)} fill="#d4bb86" fillOpacity={0.15} stroke="#e6d3a8" strokeWidth={unit * 0.2} />}
          {rect && <text x={(rect.a.x + rect.b.x) / 2} y={-(rect.a.y + rect.b.y) / 2} textAnchor="middle" fontSize={unit * 1.4} fill="#e6d3a8">{Math.abs(rect.b.x - rect.a.x).toFixed(2)} × {Math.abs(rect.b.y - rect.a.y).toFixed(2)} m</text>}
        </svg>
        {tool === "calibrate" && pts.length === 2 && (
          <form
            className="absolute bottom-3 left-3 panel p-3 flex items-center gap-2 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              const m = Number(calDist.replace(",", "."));
              if (!(m > 0)) return;
              commit((l) => calibrate(l, pts[0], pts[1], m, `distance between two points on page ${pageN ?? "?"}`));
              setPts([]); setCalDist(""); setTool("select");
            }}
          >
            <span>Traced {dist(pts[0], pts[1]).toFixed(2)} m · true length</span>
            <input autoFocus className="input w-20 !py-1" value={calDist} onChange={(e) => setCalDist(e.target.value)} placeholder="4.20" />
            <span>m</span>
            <button className="btn btn-gold !py-1">Set scale</button>
          </form>
        )}
        <div className="absolute right-2 top-2 flex gap-1">
          <button className="btn !px-2 !py-0.5 !text-xs" onClick={() => setVb(contentBox)}>Fit</button>
        </div>
        {!L.walls.length && !L.rooms.some((r) => r.polygon.length >= 3) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-stone-400">
            {plan ? "Trace rooms over the plan, then press “Walls from rooms”." : "No plan image for this level — draw walls with the Wall tool."}
          </div>
        )}
      </div>

      <Inspector level={L} wall={selWall} room={selRoom} opening={selOpening} commit={commit} onDelete={(id) => { commit((l) => removeElement(l, id)); select(null); }} />
    </div>
  );
}

function OpeningMark({ w, o, unit, selected, onPick }: { w: Wall; o: Opening; unit: number; selected: boolean; onPick: () => void }) {
  const L = dist(w.a, w.b);
  const ux = (w.b.x - w.a.x) / L, uy = (w.b.y - w.a.y) / L;
  const c = o.offset * L;
  const s = { x: w.a.x + ux * (c - o.widthM / 2), y: w.a.y + uy * (c - o.widthM / 2) };
  const e = { x: w.a.x + ux * (c + o.widthM / 2), y: w.a.y + uy * (c + o.widthM / 2) };
  const inf = isInferred(o.evidence);
  const color = o.kind === "window" ? "#8fb4c0" : o.kind === "sliding_door" ? "#a9d0dc" : "#171513";
  return (
    <g onClick={(ev) => { ev.stopPropagation(); onPick(); }} className="cursor-pointer">
      <line x1={s.x} y1={-s.y} x2={e.x} y2={-e.y} stroke={color} strokeWidth={Math.max(w.thicknessM, unit * 0.4) + unit * 0.1} />
      <line x1={s.x} y1={-s.y} x2={e.x} y2={-e.y} stroke={selected ? "#e6d3a8" : inf ? "#d9a441" : o.kind === "door" || o.kind === "opening" ? "#d4bb86" : "#cfe6ee"} strokeWidth={unit * 0.25} strokeDasharray={inf ? `${unit * 0.5} ${unit * 0.4}` : undefined} />
    </g>
  );
}

function Num({ label, value, onCommit, step = 0.01, suffix = "m" }: { label: string; value: number | undefined; onCommit: (v: number | undefined) => void; step?: number; suffix?: string }) {
  const [v, setV] = useState(value === undefined ? "" : String(Math.round(value * 1000) / 1000));
  useEffect(() => setV(value === undefined ? "" : String(Math.round(value * 1000) / 1000)), [value]);
  const done = () => { const n = v.trim() === "" ? undefined : Number(v.replace(",", ".")); if (n === undefined || Number.isFinite(n)) onCommit(n); };
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="text-stone-400 w-20">{label}</span>
      <input className="input w-20 !py-0.5" type="number" step={step} value={v} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && done()} />
      <span className="text-stone-500">{suffix}</span>
    </label>
  );
}

function Inspector({ level, wall, room, opening, commit, onDelete }: { level: Level; wall?: Wall; room?: Room; opening?: Opening; commit: (fn: (l: Level) => Level) => void; onDelete: (id: string) => void }) {
  if (!wall && !room && !opening) return <div className="text-[11px] text-stone-500">Select a wall, opening or room to edit it. Drag joints to reshape. Scroll to zoom, drag the background to pan.</div>;
  return (
    <div className="panel p-3 flex flex-wrap items-center gap-x-5 gap-y-2">
      {wall && (
        <>
          <span className="label">Wall</span>
          <Num label="Length" value={dist(wall.a, wall.b)} onCommit={(v) => v && commit((l) => setWallLength(l, wall.id, v))} />
          <Num label="Thickness" value={wall.thicknessM} onCommit={(v) => v && commit((l) => updateWall(l, wall.id, { thicknessM: v }, `thickness ${v} m`))} />
          <Num label="Height" value={wall.heightM} onCommit={(v) => v && commit((l) => updateWall(l, wall.id, { heightM: v }, `height ${v} m`))} />
          <select className="input !py-0.5 text-xs" value={wall.kind} onChange={(e) => commit((l) => updateWall(l, wall.id, { kind: e.target.value as Wall["kind"] }, `kind ${e.target.value}`))}>
            {["exterior", "interior", "partition", "glass", "railing"].map((k) => <option key={k}>{k}</option>)}
          </select>
          {isInferred(wall.evidence) && <span className="chip chip-inferred">inferred</span>}
          <button className="btn !py-0.5 !text-xs ml-auto" onClick={() => onDelete(wall.id)}>Delete</button>
        </>
      )}
      {opening && (
        <>
          <span className="label">Opening</span>
          <select className="input !py-0.5 text-xs" value={opening.kind} onChange={(e) => commit((l) => updateOpening(l, opening.id, { kind: e.target.value as Opening["kind"] }, `kind ${e.target.value}`))}>
            {["door", "sliding_door", "window", "opening"].map((k) => <option key={k}>{k}</option>)}
          </select>
          <Num label="Width" value={opening.widthM} onCommit={(v) => v && commit((l) => updateOpening(l, opening.id, { widthM: v }, `width ${v} m`))} />
          <Num label="Height" value={opening.heightM} onCommit={(v) => v && commit((l) => updateOpening(l, opening.id, { heightM: v }, `height ${v} m`))} />
          {opening.kind === "window" && <Num label="Sill" value={opening.sillM} onCommit={(v) => commit((l) => updateOpening(l, opening.id, { sillM: v }, `sill ${v} m`))} />}
          <Num label="Position" value={opening.offset} step={0.01} suffix="0-1" onCommit={(v) => v !== undefined && commit((l) => updateOpening(l, opening.id, { offset: Math.min(1, Math.max(0, v)) }, `position ${v}`))} />
          {isInferred(opening.evidence) && <span className="chip chip-inferred">inferred</span>}
          <button className="btn !py-0.5 !text-xs ml-auto" onClick={() => onDelete(opening.id)}>Delete</button>
        </>
      )}
      {room && (
        <>
          <span className="label">Room</span>
          <input className="input !py-0.5 text-xs w-44" defaultValue={room.name} key={room.id + room.name} onBlur={(e) => e.target.value !== room.name && commit((l) => updateRoom(l, room.id, { name: e.target.value }, `renamed to ${e.target.value}`))} />
          <select className="input !py-0.5 text-xs" value={room.program} onChange={(e) => commit((l) => updateRoom(l, room.id, { program: e.target.value }, `program ${e.target.value}`))}>
            {PROGRAMS.map((p) => <option key={p}>{p}</option>)}
          </select>
          <Num label="Area (doc)" value={room.areaM2} suffix="m²" onCommit={(v) => commit((l) => updateRoom(l, room.id, { areaM2: v }, `documented area ${v ?? "cleared"}`))} />
          <Num label="Ceiling" value={room.ceilingHeightM} onCommit={(v) => commit((l) => updateRoom(l, room.id, { ceilingHeightM: v }, `ceiling ${v ?? "default"} m`))} />
          {room.polygon.length >= 3 && <span className="text-xs text-stone-400">traced {polygonArea(room.polygon).toFixed(2)} m²</span>}
          {room.polygon.length < 3 && <span className="chip chip-inferred">not placed — drag its outline with Trace room</span>}
          <button className="btn !py-0.5 !text-xs ml-auto" onClick={() => onDelete(room.id)}>Delete</button>
        </>
      )}
      <span className="hidden">{level.id}</span>
    </div>
  );
}
