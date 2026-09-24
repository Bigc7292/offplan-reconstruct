import Link from "next/link";
import { Brand, Footer } from "@/components/Brand";
import { DropZone } from "@/components/DropZone";
import { listJobs } from "@/lib/store";
import { extractorKind, extractorLabel } from "@/lib/llm";

export const dynamic = "force-dynamic";

export default async function Home() {
  const jobs = (await listJobs()).slice(0, 12);
  const extractor = extractorKind();
  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-8 py-5 flex items-center justify-between border-b border-stone-800">
        <Brand />
        <span className={`chip ${extractor !== "local" ? "chip-gold" : ""}`} title={extractor !== "local" ? "Vision extraction on" : "Set a model key in .env.local to enable vision plan tracing"}>
          extractor: {extractorLabel()}
        </span>
      </header>
      <section className="flex-1 max-w-5xl w-full mx-auto px-6 py-10 space-y-10">
        <div className="space-y-3">
          <h1 className="font-[family-name:var(--font-display)] text-5xl text-stone-100 leading-tight">
            Walk through the unit <span className="text-champagne-300">before it exists.</span>
          </h1>
          <p className="text-stone-400 max-w-2xl">
            Every page of the brochure is read — plans, dimensions, finishes, renders, disclaimers — and the unit you choose is rebuilt in 3D.
            Each wall, room and finish links back to the page that justifies it. Anything not printed is marked as inferred.
          </p>
        </div>
        <DropZone />
        {jobs.length > 0 && (
          <div className="space-y-3">
            <div className="label">Recent reconstructions</div>
            <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link href={j.status === "ready" ? `/jobs/${j.id}/model` : `/jobs/${j.id}`} className="panel block p-4 hover:border-champagne-600 transition">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-stone-100">{j.title}</div>
                      {j.demo && <span className="chip chip-inferred">DEMO</span>}
                    </div>
                    <div className="text-xs text-stone-400 mt-1">
                      {j.status} · {j.pages.length} page(s) · {new Date(j.createdAt).toLocaleString()}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <Footer />
    </main>
  );
}
