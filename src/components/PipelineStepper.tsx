"use client";
import { useEffect, useRef, useState } from "react";
import type { Job, LogEntry } from "@/lib/schema";

const LABELS: Record<string, string> = {
  create: "Create", ingest: "Ingest", classify: "Classify", extract: "Dossier", review: "Review", reconstruct: "Reconstruct", export: "Export",
};

export function PipelineStepper({ job, logs }: { job: Job; logs: LogEntry[] }) {
  const [open, setOpen] = useState(job.status === "running" || job.status === "queued");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (job.status === "running") setOpen(true); }, [job.status]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [logs.length, open]);
  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {job.stages.map((s, i) => (
          <div key={s.name} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                s.status === "done" ? "border-champagne-600 text-champagne-300"
                  : s.status === "running" ? "border-champagne-400 text-stone-100 animate-pulse"
                  : s.status === "waiting" ? "border-inferred text-inferred"
                  : s.status === "error" ? "border-danger text-danger"
                  : "border-stone-700 text-stone-500"
              }`}
              title={s.error ?? s.status}
            >
              <span>{s.status === "done" ? "✓" : s.status === "error" ? "!" : s.status === "waiting" ? "◷" : i + 1}</span>
              {LABELS[s.name]}
            </div>
            {i < job.stages.length - 1 && <span className="text-stone-700">—</span>}
          </div>
        ))}
        <button className="ml-auto text-xs text-stone-400 hover:text-stone-100" onClick={() => setOpen(!open)}>{open ? "Hide log" : `Show log (${logs.length})`}</button>
      </div>
      {open && (
        <div ref={box} className="max-h-56 overflow-auto scroll-thin rounded-md bg-stone-950/70 p-3 font-mono text-[11px] leading-relaxed">
          {logs.map((l, i) => (
            <div key={i} className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-inferred" : l.level === "fact" ? "text-champagne-300" : "text-stone-300"}>
              <span className="text-stone-600">{l.t.slice(11, 19)} {l.stage.padEnd(11)}</span> {l.msg}
            </div>
          ))}
          {!logs.length && <div className="text-stone-500">Waiting for the pipeline…</div>}
        </div>
      )}
    </div>
  );
}
