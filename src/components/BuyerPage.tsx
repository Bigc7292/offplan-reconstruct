"use client";
// The page a buyer is sent: the property at a glance (hero, key facts, the walkthrough video, renders), a
// button into the 3D tour, and where every number came from, one card per source. No editing chrome and
// none of the reading internals; "Explore the model" opens the full interactive viewer.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { PropertyDossier, PropertySceneGraph, SourceRecord } from "@/lib/schema";
import { fileUrl } from "@/lib/client-store";

type Render = { name: string; kind: string; title: string; file: string; level?: string };
type Still = { file: string; kind: string; title: string; subtitle?: string };

const FACTS: Array<{ label: string; keys: RegExp; unit?: string }> = [
  { label: "Bedrooms", keys: /^(beds|bedrooms)$/ },
  { label: "Bathrooms", keys: /^(baths|bathrooms)$/ },
  { label: "Built-up area", keys: /^area\.(bua|built_up|internal)_m2$/, unit: "m²" },
  { label: "Plot", keys: /^area\.plot_m2$/, unit: "m²" },
  { label: "Floors", keys: /^storeys$/ },
  { label: "Handover", keys: /^handover$/ },
  { label: "Location", keys: /^location$/ },
];

function exists(url: string) {
  return fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
}

export function BuyerPage({ jobId, scene, dossier, sources, onExplore }: {
  jobId: string; scene: PropertySceneGraph; dossier: PropertyDossier | null; sources: SourceRecord[]; onExplore: () => void;
}) {
  const [renders, setRenders] = useState<Render[]>([]);
  const [stills, setStills] = useState<Still[]>([]);
  const [video, setVideo] = useState<{ mp4: string; poster: string } | null>(null);
  useEffect(() => {
    void (async () => {
      const json = (rel: string) => fetch(fileUrl(jobId, rel)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // only pictures of this version of the model: a rebuild makes older renders and stills stale
      const [idx, st] = await Promise.all([json("renders/index.json"), json("exports/stills.json")]);
      if (idx?.shots && idx.dossierHash === scene.dossierHash) setRenders(idx.shots as Render[]);
      if (st?.stills && st.dossierHash === scene.dossierHash) setStills(st.stills as Still[]);
      const mp4 = fileUrl(jobId, "exports/walkthrough.mp4"), poster = fileUrl(jobId, "exports/walkthrough-poster.jpg");
      if (await exists(mp4)) setVideo({ mp4, poster });
    })();
  }, [jobId, scene.dossierHash]);

  const facts = useMemo(() => {
    const out: Array<{ label: string; value: string }> = [];
    for (const f of FACTS) {
      const hit = dossier?.facts.find((x) => f.keys.test(x.key));
      if (hit) out.push({ label: f.label, value: `${hit.value.replace(/\s*\(.*\)$/, "")}${f.unit ? ` ${f.unit}` : ""}` });
    }
    if (!out.some((f) => f.label === "Floors")) out.push({ label: "Floors", value: String(scene.levels.length) });
    return out;
  }, [dossier, scene.levels.length]);

  const hero = renders.find((r) => r.kind === "exterior")?.file ?? stills.find((x) => x.kind === "exterior")?.file;
  const floors = [...scene.levels].sort((a, b) => a.elevationM - b.elevationM);
  const gallery: Array<{ key: string; file: string; title: string }> = renders.length
    ? renders.filter((r) => r.kind !== "cutaway").map((r) => ({ key: r.name, file: r.file, title: r.title }))
    : stills.filter((x) => x.kind !== "exterior").map((x) => ({ key: x.file, file: x.file, title: x.subtitle ? `${x.title} · ${x.subtitle}` : x.title }));

  return (
    <main className="min-h-screen bg-stone-950 text-stone-200">
      <section className="relative h-[62vh] min-h-[380px] w-full overflow-hidden">
        {hero ? <img src={fileUrl(jobId, hero)} alt="" className="absolute inset-0 h-full w-full object-cover" />
          : video ? <img src={video.poster} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <div className="absolute inset-0 bg-stone-900" />}
        <div className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/30 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 mx-auto max-w-6xl px-4 pb-8 sm:px-8">
          <div className="text-[11px] uppercase tracking-[0.3em] text-champagne-300">Off-plan · 3D walkthrough</div>
          <h1 className="mt-1 text-3xl font-light text-white sm:text-5xl">{scene.title}</h1>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href={`/tour/${jobId}`} className="btn btn-gold !px-5 !py-2 text-sm" data-testid="start-tour">Start the 3D tour</Link>
            <button className="btn !px-5 !py-2 text-sm" onClick={onExplore} data-testid="explore-model">Explore the model</button>
            {video && <a href="#video" className="btn !px-5 !py-2 text-sm">Watch the video</a>}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-12 px-4 py-10 sm:px-8">
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="key-facts">
          {facts.map((f) => (
            <div key={f.label} className="rounded-lg border border-stone-800 bg-stone-900/60 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wider text-stone-500">{f.label}</div>
              <div className="mt-1 text-sm text-stone-100">{f.value}</div>
            </div>
          ))}
        </section>

        {video && (
          <section id="video">
            <h2 className="mb-3 text-lg font-light text-white">Walkthrough</h2>
            <video src={video.mp4} poster={video.poster} controls playsInline className="w-full rounded-lg border border-stone-800 bg-black" />
          </section>
        )}

        {gallery.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-light text-white">Inside the model</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {gallery.map((r) => (
                <figure key={r.key} className="overflow-hidden rounded-lg border border-stone-800 bg-stone-900">
                  <img src={fileUrl(jobId, r.file)} alt={r.title} className="aspect-video w-full object-cover" />
                  <figcaption className="px-3 py-2 text-xs text-stone-400">{r.title}</figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-lg font-light text-white">Rooms, floor by floor</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {floors.map((l) => {
              const rooms = scene.rooms.filter((r) => r.levelId === l.id && !/unlabelled/i.test(r.name) && r.areaM2 >= 3).sort((a, b) => b.areaM2 - a.areaM2);
              if (!rooms.length) return null;
              return (
                <div key={l.id} className="rounded-lg border border-stone-800 bg-stone-900/60 p-4">
                  <div className="mb-2 text-sm text-champagne-300">{l.name}</div>
                  <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                    {rooms.slice(0, 14).map((r) => (
                      <li key={r.id} className="flex justify-between gap-2">
                        <span className="truncate text-stone-300">{r.name}</span>
                        <span className="shrink-0 text-stone-500">{r.printedDims ? `${r.printedDims} m` : `${r.areaM2.toFixed(1)} m²`}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-light text-white">Where this comes from</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {sources.filter((s) => s.status !== "error").map((s) => (
              <div key={s.id} className="rounded-lg border border-stone-800 bg-stone-900/60 p-4 text-sm">
                <div className="text-[10px] uppercase tracking-wider text-stone-500">{s.origin ? "Floor plan found online" : s.kind === "url" ? "Listing page" : s.kind === "pdf" ? "Sales brochure" : "Source"}</div>
                <div className="mt-1 truncate text-stone-100">{s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.name}</a> : s.name}</div>
                {s.pageCount ? <div className="mt-1 text-xs text-stone-500">{s.pageCount} pages</div> : null}
              </div>
            ))}
          </div>
        </section>

        <div className="flex justify-center pb-6">
          <span className="rounded-full border border-stone-700 px-4 py-1.5 text-xs text-stone-400" data-testid="disclaimer">{scene.disclaimer} Furniture is illustrative.</span>
        </div>
      </div>
    </main>
  );
}
