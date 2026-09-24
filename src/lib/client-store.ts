"use client";
// Client dossier/scene state shared by the review page, plan editor and viewer.
import { create } from "zustand";
import type { Job, Level, LogEntry, PropertyDossier, PropertySceneGraph } from "./schema";

export type Selection = { id: string; kind: "room" | "wall" | "opening" | "furniture" | "material" | "fact" | "piece"; levelId?: string } | null;

type State = {
  jobId: string;
  job: Job | null;
  dossier: PropertyDossier | null;
  scene: PropertySceneGraph | null;
  logs: LogEntry[];
  logOffset: number;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  selection: Selection;
  pulse: number;
  pageFocus: { page: number; bbox?: [number, number, number, number] } | null;
  levelId: string | null;
  setJobData: (d: { job: Job; dossier: PropertyDossier | null; logs: LogEntry[]; logOffset: number }) => void;
  setScene: (s: PropertySceneGraph | null) => void;
  select: (s: Selection, pulse?: boolean) => void;
  focusPage: (p: State["pageFocus"]) => void;
  setLevel: (id: string) => void;
  editDossier: (fn: (d: PropertyDossier) => PropertyDossier) => void;
  editLevel: (levelId: string, fn: (l: Level) => Level) => void;
  save: () => Promise<boolean>;
  reconstruct: () => Promise<PropertySceneGraph | null>;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useStudio = create<State>((set, get) => ({
  jobId: "",
  job: null,
  dossier: null,
  scene: null,
  logs: [],
  logOffset: 0,
  dirty: false,
  saving: false,
  saveError: "",
  selection: null,
  pulse: 0,
  pageFocus: null,
  levelId: null,
  setJobData: ({ job, dossier, logs, logOffset }) =>
    set((s) => ({
      jobId: job.id,
      job,
      // never clobber unsaved local edits with a poll result
      dossier: s.dirty || s.saving ? s.dossier : dossier,
      logs: logOffset === s.logOffset ? s.logs : [...s.logs, ...logs].slice(-2000),
      logOffset,
      levelId: s.levelId ?? pickLevel(dossier),
    })),
  setScene: (scene) => set({ scene }),
  select: (selection, pulse) => set((s) => ({ selection, pulse: pulse ? s.pulse + 1 : s.pulse, levelId: selection?.levelId ?? s.levelId })),
  focusPage: (pageFocus) => set({ pageFocus }),
  setLevel: (levelId) => set({ levelId }),
  editDossier: (fn) => {
    const d = get().dossier;
    if (!d) return;
    set({ dossier: fn(d), dirty: true });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().save(), 500);
  },
  editLevel: (levelId, fn) => get().editDossier((d) => ({ ...d, levels: d.levels.map((l) => (l.id === levelId ? fn(l) : l)) })),
  save: async () => {
    const { dossier, jobId } = get();
    if (!dossier) return false;
    set({ saving: true, saveError: "" });
    const sent = dossier;
    const res = await fetch(`/api/jobs/${jobId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(dossier) });
    const body = await res.json();
    if (!res.ok) {
      set({ saving: false, saveError: body.error ?? "Save failed" });
      return false;
    }
    // keep edits made while the request was in flight
    set((s) => ({ saving: false, dirty: s.dossier !== sent, dossier: s.dossier === sent ? body.dossier : s.dossier }));
    if (get().scene) void get().reconstruct();
    return true;
  },
  reconstruct: async () => {
    const { jobId } = get();
    const res = await fetch(`/api/jobs/${jobId}/reconstruct`, { method: "POST" });
    if (!res.ok) return null;
    const g = (await res.json()) as PropertySceneGraph;
    set({ scene: g });
    return g;
  },
}));

function pickLevel(d: PropertyDossier | null) {
  if (!d?.levels.length) return null;
  const ut = d.unitTypes.find((u) => u.id === d.selectedUnitTypeId);
  return d.levels.find((l) => ut?.levelIds.includes(l.id))?.id ?? d.levels[0].id;
}

export function fileUrl(jobId: string, rel: string) {
  return rel.startsWith("/") ? rel : `/api/jobs/${jobId}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
}
