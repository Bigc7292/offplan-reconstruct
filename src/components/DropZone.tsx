"use client";
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function DropZone() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState("");
  const [unitFocus, setUnitFocus] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"" | "upload" | "demo">("");
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const add = useCallback((list: FileList | File[]) => {
    const accepted = [...list].filter((f) => /pdf|image\//.test(f.type) || /\.(pdf|png|jpe?g|webp)$/i.test(f.name));
    setFiles((prev) => [...prev, ...accepted.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);
  }, []);

  async function submit() {
    setErr("");
    if (!files.length && !urls.trim()) return setErr("Add a brochure PDF, plan image or listing URL.");
    setBusy("upload");
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("urls", urls);
    fd.append("unitFocus", unitFocus);
    fd.append("notes", notes);
    const res = await fetch("/api/jobs", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) { setBusy(""); return setErr(body.error ?? "Upload failed"); }
    router.push(`/jobs/${body.id}`);
  }

  async function demo() {
    setBusy("demo");
    const res = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ demo: true }) });
    const body = await res.json();
    router.push(`/jobs/${body.id}`);
  }

  return (
    <div className="panel p-6 space-y-5">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-xl border border-dashed ${over ? "border-champagne-400 bg-stone-800" : "border-stone-600 bg-stone-900/60"} px-6 py-10 text-center transition`}
      >
        <input ref={input} type="file" multiple accept="application/pdf,image/*" className="hidden" onChange={(e) => e.target.files && add(e.target.files)} />
        <div className="font-[family-name:var(--font-display)] text-2xl text-stone-100">Drop brochures, plans and renders</div>
        <div className="text-sm text-stone-400 mt-1">PDF brochures (scanned or vector, EN/AR), floor plan images, CGI, material boards</div>
        {files.length > 0 && (
          <ul className="mt-4 flex flex-wrap justify-center gap-2" onClick={(e) => e.stopPropagation()}>
            {files.map((f) => (
              <li key={f.name + f.size} className="chip chip-gold">
                {f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB
                <button className="ml-1 text-stone-400 hover:text-stone-100" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}>×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <label className="space-y-1 block">
          <span className="label">Listing URLs (one per line)</span>
          <textarea className="input w-full h-20 resize-none" placeholder="https://www.developer.com/project/unit-type-c" value={urls} onChange={(e) => setUrls(e.target.value)} />
        </label>
        <div className="space-y-3">
          <label className="space-y-1 block">
            <span className="label">I want unit type</span>
            <input className="input w-full" placeholder="e.g. Type C, 2BR + Maid, Level 22" value={unitFocus} onChange={(e) => setUnitFocus(e.target.value)} />
          </label>
          <label className="space-y-1 block">
            <span className="label">Notes (optional)</span>
            <input className="input w-full" placeholder="Preferred finish package, unit number…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
      </div>
      {err && <div className="text-sm text-danger">{err}</div>}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button className="btn" onClick={demo} disabled={!!busy}>{busy === "demo" ? "Loading demo…" : "Try the DEMO unit"}</button>
        <button className="btn btn-gold" onClick={submit} disabled={!!busy}>{busy === "upload" ? "Uploading…" : "Start reconstruction"}</button>
      </div>
    </div>
  );
}
