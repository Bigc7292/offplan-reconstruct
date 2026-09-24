# OffPlan Reconstruct: progress

Turns off-plan brochure PDFs and listing URLs into a source-faithful, walkable 3D model of one unit.
Every wall, room and finish links back to the page or render that justifies it; anything not printed is marked inferred.

## Architecture (10 bullets)

1. **Next.js 15 App Router + TypeScript + Tailwind 4**; the 3D viewer is React Three Fiber + drei, loaded client-only (`ViewerDynamic`).
2. **Job folders** under `DATA_DIR` (default `./data/jobs/{id}`): `job.json`, `source/` (originals, kept downloadable), `pages/` (renders, thumbs, text), `assets/`, `dossier.json`, `evidence.json`, `scene-graph.json`, `exports/`, `logs.jsonl`, `model-calls.jsonl`.
3. **Pipeline stages** `create → ingest → classify → extract → review → reconstruct → export` (`src/lib/pipeline.ts`), each with status and logs streamed to the UI.
4. **Ingest** (`pdf.ts`, `url-ingest.ts`, `ingest.ts`): pdfjs renders every page, keeps the text layer with bounding boxes, falls back to tesseract OCR, extracts embedded images (drops off-page and backdrop art, dedupes by perceptual hash). URLs: HTML, meta/og, JSON-LD, images, linked PDFs, Playwright screenshot. Login walls, captchas and 401/403/429 are reported, never bypassed; private hosts are refused unless `ALLOW_PRIVATE_URLS=1`.
5. **Classify** every page into the spec's labels (`classify.ts`): Claude vision when `ANTHROPIC_API_KEY` is set, otherwise keyword + image-signal scoring. Captions like "Ground floor – Kitchen" are read from text or OCR.
6. **Extract** behind one interface (`extract.ts` → `extract-facts.ts`, `extract-plan.ts`, `extract-materials.ts`): facts (areas m²/sq ft with consistency checks, prices marked "as printed, unconfirmed", payment plan, handover, service charge, disclaimers), unit types, levels and room schedules, finishes and CGI-sampled tones bound to room programs. Two plans with the same name are kept apart and warned about, never averaged.
7. **Property Dossier** (`schema.ts`, zod) is the single source of truth and follows the spec's data model, with a few marked extensions (plan calibration, furniture proxies, material→room bindings). Evidence refs starting `inferred:` mark defaults.
8. **Review UI** (`/jobs/[id]`): pipeline stepper, page filmstrip, source page with evidence bbox highlight, dossier table (facts/rooms/walls/finishes/warnings), 2D plan editor over the source plan (calibrate scale, trace rooms, draw walls/doors/windows, drag joints, edit lengths, "Walls from rooms", "Add inferred doors"). Edits save automatically and write reviewer evidence.
9. **Deterministic builder** (`reconstruct.ts`): dossier → scene graph (walls split by openings, glass, railings, sills/lintels, door leaves, slabs, ceilings, furniture proxies, colliders, spawn). No clock, randomness or model calls; `dossierHash` proves same dossier → same model. Inferred pieces are tinted amber in 3D and dashed in 2D.
10. **Viewer and export** (`/jobs/[id]/model`, `/view/[id]`): dollhouse, walk (WASD + mouse look, wall collisions), plan view with source overlay, measure, room jump, mini-map, north arrow, day/dusk, "only attested", evidence drawer on click, screenshot, GLB export (custom writer, passes the Khronos validator with 0 errors) and scene-graph JSON. Footer on every page: "Reconstructed from sales materials — not a survey."

## Status

- **Phase 1 (vertical slice): done.** The DEMO unit (clearly labelled, not an extracted project) walks end to end.
- **Phase 2 (ingest): done** for PDFs, images and public URLs, including linked PDFs and scanned/OCR pages.
- **Phase 3 (intelligence): local extractor done; Claude vision path written but not yet run** (no API key in this environment). With a key, plan pages go to Claude with the draughtsman prompt and come back as walls/rooms/openings; without one, rooms arrive *unplaced* from the printed schedule and are traced by the reviewer over the calibrated plan.
- **Phase 4 (fidelity): partial.** CGI tone sampling per room program works; CGI crops are not yet used as textures.

## Acceptance run (`npm run build && npm start`, then `PDF=/path/brochure.pdf npm test`)

Last run 2026-09-24, headless Chromium with software WebGL: **13/13 passed.**

| Step | Result |
|---|---|
| A1 DEMO model generated | 12 rooms, 20 walls |
| A2 edit a wall length → 3D updates | dossier hash and scene rebuilt |
| A3 walk living → kitchen → master with W only | through the open-plan kitchen, corridor, walk-in door and master opening |
| A3b walls collide | stopped 0.36 m short of the east wall |
| A4 click kitchen floor → evidence | room, area, finish and the plan evidence |
| A5 GLB export | 135 KB, 0 validator errors |
| A6 reload / rebuild | byte-identical scene graph |
| A7 share page | renders |
| B1–B4 Ninteen brochure PDF + a listing URL linking it | 14 pages, every page classified, 16 rooms on 4 levels with page evidence, BUA/plot/beds/type/storeys/service charge extracted |

## Known gaps

- Real brochures with the local extractor give room *names* per level but no geometry and (for Ninteen) no printed room areas; geometry needs tracing in the plan editor, or the Claude vision path.
- The Claude path has no server-side fallback if a call fails mid-job; the stage errors and can be re-run from the review page.
- The Al Barari renders PDF has no floor plan, so it yields finishes and captions only; the title deed yields registry facts only (and contains owner names: treat as sensitive).
- Fonts load from Google Fonts; offline, the UI falls back to system fonts.
