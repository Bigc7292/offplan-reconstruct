// Stage 3B: floor / unit plan geometry.
//
// Claude path: each plan image goes through the draughtsman prompt and comes back as
// Level geometry in metres (or pixels + low scaleConfidence when scale is unproven).
//
// Local path (no API key): plan images are found and paired with the level names and
// room schedules printed beside them. Rooms are created *unplaced* (no polygon) with
// their source quote, and the plan image is attached as a trace underlay with an
// uncalibrated scale. Nothing is drawn that the documents do not show; the reviewer
// calibrates the scale from one printed dimension and traces the rooms in the editor.
import type { Evidence, Level, PageRecord, Room, Wall, Furniture, UnitType } from "./schema";
import { inferredEvidence } from "./schema";
import { LEVEL_WORDS, ROOM_WORDS } from "./classify";
import type { AssetIndexEntry } from "./ingest";
import { callStructured, PLAN_SYSTEM, PlanLevelSchema, type PlanLevelOut } from "./llm";
import { jobFile, log } from "./store";
import { DEFAULT_CEILING_M } from "./reconstruct";
import { round } from "./geom";

type LabelledAsset = AssetIndexEntry & { kind: string; caption?: string };

export const FLOOR_TO_FLOOR_DEFAULT_M = 3.5;

export function levelRank(name: string): number {
  const n = name.toLowerCase();
  if (/basement|lower/.test(n)) return -1;
  if (/ground|podium|groundfloor/.test(n)) return 0;
  if (/mezz/.test(n)) return 0.5;
  if (/first/.test(n)) return 1;
  if (/second/.test(n)) return 2;
  if (/third/.test(n)) return 3;
  if (/roof/.test(n)) return 9;
  const m = n.match(/level\s*(\d+)/);
  if (m) return Number(m[1]);
  return 5;
}

export function canonicalLevelName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (/^groundfloor$/i.test(s)) return "Ground Floor";
  if (/^rooftop$|^roof top$/i.test(s)) return "Rooftop";
  return s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase());
}

export function programFor(name: string): string {
  const n = name.toLowerCase();
  if (/bed|master|guest\s*room|maid|driver|nanny|staff|chef/.test(n)) return "bedroom";
  if (/living|lounge|majlis|family|formal|dining|sunken/.test(n)) return "living";
  if (/kitchen|pantry/.test(n)) return "kitchen";
  if (/bath|powder|toilet|wc|en-?suite|shower/.test(n)) return "bath";
  if (/balcony|terrace|pool|garden|deck|bbq|plunge/.test(n)) return "balcony";
  if (/lobby|entrance|foyer|corridor|lift|elevator|stair|ramp|hall/.test(n)) return "circulation";
  if (/store|storage|closet|walk|dress|wardrobe|laundry|utility|vault|services?|tank|pump|sump|ahu/.test(n)) return "storage";
  if (/gym|cinema|office|study|bar|showroom|car\s*wash|parking|garage/.test(n)) return "amenity";
  return "other";
}

type ListEntry = { name: string; quote: string; bbox?: [number, number, number, number] };
type ListBlock = { level: string; header: { bbox?: [number, number, number, number]; quote: string }; entries: ListEntry[] };

/** Level headers followed by bullet lists, e.g. "Groundfloor • Guest Bedroom • BBQ Area". */
export function parseScheduleLists(p: PageRecord): ListBlock[] {
  const blocks: ListBlock[] = [];
  let cur: ListBlock | null = null;
  const items = p.items.length ? p.items : p.text.split("\n").map((str) => ({ str, bbox: undefined as unknown as [number, number, number, number] }));
  for (const it of items) {
    const raw = it.str.replace(/^[\s•·\-–*]+/, "").trim();
    if (!raw) continue;
    const isHeader = raw.length <= 22 && LEVEL_WORDS.test(raw) && raw.replace(LEVEL_WORDS, "").replace(/[^a-z]/gi, "").length <= 3;
    if (isHeader) {
      // the same level word printed as a drawing caption is handled separately (see drawingCaption)
      cur = { level: canonicalLevelName(raw.match(LEVEL_WORDS)![0]), header: { bbox: it.bbox, quote: raw }, entries: [] };
      blocks.push(cur);
      continue;
    }
    if (cur && raw.length <= 40 && (new RegExp(ROOM_WORDS.source, "i").test(raw) || /^\d+\s*x\s+/i.test(raw))) {
      cur.entries.push({ name: raw.replace(/\s+/g, " "), quote: raw, bbox: it.bbox });
    }
  }
  return blocks.filter((b) => b.entries.length);
}

/** Level word printed directly under/over a plan image (the drawing's own label). */
function drawingCaption(p: PageRecord, bbox: [number, number, number, number]) {
  let best: { s: string; d: number; bbox: [number, number, number, number] } | undefined;
  for (const it of p.items) {
    const s = it.str.trim();
    if (!LEVEL_WORDS.test(s) || s.length > 24) continue;
    const cx = (it.bbox[0] + it.bbox[2]) / 2;
    if (cx < bbox[0] || cx > bbox[2]) continue;
    const below = it.bbox[1] - bbox[3];
    const above = bbox[1] - it.bbox[3];
    const d = below >= -0.02 && below < 0.12 ? below : above >= -0.02 && above < 0.08 ? above : Infinity;
    if (d < (best?.d ?? Infinity)) best = { s, d, bbox: it.bbox };
  }
  return best ? { name: canonicalLevelName(best.s.match(LEVEL_WORDS)![0]), quote: best.s, bbox: best.bbox } : undefined;
}

export async function extractPlans(
  jobId: string, pages: PageRecord[], assets: LabelledAsset[], unitTypes: UnitType[], useClaude: boolean, ceilingFact?: { value: number; evidence: Evidence },
): Promise<{ levels: Level[]; warnings: string[]; northDeg?: number; unitTypes: UnitType[]; planAssetIds: string[] }> {
  const warnings: string[] = [];
  const levels: Level[] = [];
  const planAssetIds: string[] = [];
  let northDeg: number | undefined;
  const planPages = pages.filter((p) => p.labels.some((l) => l === "unit_plan" || l === "typical_floor" || l === "furniture_layout"));
  if (!planPages.length) warnings.push("No floor plan found. Add the unit plan page or another brochure to reconstruct geometry.");

  for (const p of planPages) {
    const crops = assets.filter((a) => a.page === p.n && (a.kind === "unit_plan" || a.kind === "floor_plan"));
    const planImgs: Array<{ id: string; path: string; bbox: [number, number, number, number]; w: number; h: number }> =
      crops.length ? crops : assets.filter((a) => a.page === p.n && a.origin !== "pdf_crop").map((a) => ({ ...a, bbox: [0, 0, 1, 1] as [number, number, number, number] }));
    if (!planImgs.length) planImgs.push({ id: `a${p.n}-page`, path: p.image, bbox: [0, 0, 1, 1], w: p.widthPx, h: p.heightPx });
    const lists = parseScheduleLists(p);

    // pair each plan with the nearest schedule list by horizontal distance
    const used = new Set<number>();
    for (const img of [...planImgs].sort((a, b) => a.bbox[0] - b.bbox[0])) {
      planAssetIds.push(img.id);
      const cap = drawingCaption(p, img.bbox);
      const cx = (img.bbox[0] + img.bbox[2]) / 2;
      let li = -1, ld = Infinity;
      lists.forEach((l, i) => {
        if (used.has(i) || !l.header.bbox) return;
        const d = Math.abs((l.header.bbox[0] + l.header.bbox[2]) / 2 - cx);
        if (d < ld) { ld = d; li = i; }
      });
      if (li < 0 && lists.length === 1 && !used.has(0)) li = 0;
      const list = li >= 0 ? lists[li] : undefined;
      if (li >= 0) used.add(li);

      const name = cap?.name ?? list?.level ?? `Plan (page ${p.n})`;
      if (cap && list && cap.name !== list.level) {
        warnings.push(`Page ${p.n}: the drawing is captioned "${cap.quote}" but the list beside it is headed "${list.header.quote}". The level is named from the drawing caption; please confirm which floor it is.`);
      }
      const levelId = `L-p${p.n}-${planImgs.indexOf(img) + 1}`;
      const heightM = ceilingFact?.value ?? DEFAULT_CEILING_M;

      if (useClaude) {
        try {
          const out = await callStructured(jobId, {
            task: `plan ${levelId}`, system: PLAN_SYSTEM, schema: PlanLevelSchema, schemaName: "Level",
            prompt: `This is a plan image cut from brochure page ${p.n}. Nearby text on the page:\n"""\n${p.text.slice(0, 3000)}\n"""\nReturn the level geometry.`,
            images: [jobFile(jobId, img.path)],
          });
          const lvl = planOutToLevel(out, { levelId, pageN: p.n, img, heightM, ceilingFact });
          if (out.northArrowDeg !== null && northDeg === undefined) northDeg = out.northArrowDeg;
          if (lvl.plan!.scaleConfidence < 0.4) warnings.push(`${lvl.name}: scale not proven (${out.scaleSource}). Calibrate from a printed dimension in the plan editor.`);
          levels.push(lvl);
          await log(jobId, "extract", `${lvl.name}: ${lvl.rooms.length} room(s), ${lvl.walls.length} wall(s) from vision model (scale confidence ${out.scaleConfidence.toFixed(2)}).`);
          continue;
        } catch (e) {
          warnings.push(`Page ${p.n}: vision plan extraction failed (${e instanceof Error ? e.message : e}); falling back to the room schedule + trace underlay.`);
        }
      }

      const rooms: Room[] = (list?.entries ?? []).map((e, i) => ({
        id: `${levelId}-r${i + 1}`,
        name: e.name,
        program: programFor(e.name),
        polygon: [],
        levelId,
        adjacentRoomIds: [],
        evidence: [{ source: "pdf", ref: `page-${p.n}`, quote: `${list!.header.quote}: ${e.quote}`, bbox: e.bbox, confidence: p.textSource === "ocr" ? 0.55 : 0.8 }],
      }));
      levels.push({
        id: levelId,
        name,
        elevationM: 0,
        heightM,
        rooms,
        walls: [],
        plan: {
          assetId: img.id,
          imagePath: img.path,
          imageW: img.w,
          imageH: img.h,
          pxPerM: round(img.w / 20, 3),
          originPx: { x: 0, y: img.h },
          scaleConfidence: 0,
          evidence: [inferredEvidence("scale-uncalibrated: no scale bar read; calibrate from a printed dimension", 0)],
        },
      });
      await log(jobId, "extract", `${name} (page ${p.n}): plan image attached as trace underlay; ${rooms.length} room(s) listed but not yet placed.`, rooms.length ? "info" : "warn");
    }
  }

  const names = new Map<string, string[]>();
  for (const l of levels) names.set(l.name, [...(names.get(l.name) ?? []), l.id]);
  for (const [n, ids] of names) if (ids.length > 1) warnings.push(`${ids.length} plans are labelled "${n}" (${ids.map((i) => `page ${i.match(/^L-p(\d+)/)?.[1]}`).join(", ")}). Rename or delete the wrong one in review; plans are never merged.`);

  // stack levels by name; floor-to-floor is a default unless a section/elevation gave it
  const ranks = [...new Set(levels.map((l) => levelRank(l.name)))].sort((a, b) => a - b);
  const groundIdx = Math.max(0, ranks.indexOf(0));
  for (const l of levels) {
    const idx = ranks.indexOf(levelRank(l.name));
    l.elevationM = round((idx - groundIdx) * FLOOR_TO_FLOOR_DEFAULT_M, 3);
  }
  if (levels.length > 1) warnings.push(`Level elevations use a default ${FLOOR_TO_FLOOR_DEFAULT_M} m floor-to-floor (not printed in the brochure).`);

  // attach levels to unit types without ever merging types
  const types = [...unitTypes];
  for (const l of levels) {
    const pageN = Number(l.id.match(/^L-p(\d+)/)?.[1]);
    const page = pages.find((p) => p.n === pageN);
    const onPage = types.find((u) => page?.text.toUpperCase().includes(u.code.toUpperCase()));
    let ut = onPage ?? (types.length === 1 ? types[0] : undefined);
    if (!ut) {
      const heading = page?.text.split("\n").find((s) => /\b\d\s*bed(room)?\b.*\b(villa|apartment|unit|townhouse|penthouse)\b/i.test(s))?.trim();
      const code = heading ? heading.replace(/\s+/g, " ").toUpperCase() : "Unassigned plans";
      ut = types.find((u) => u.code === code);
      if (!ut) {
        ut = { id: `ut-${code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, code, beds: Number(code.match(/(\d)\s*BED/)?.[1]) || undefined, levelIds: [] };
        types.push(ut);
      }
    }
    l.unitTypeId = ut.id;
    if (!ut.levelIds.includes(l.id)) ut.levelIds.push(l.id);
    if (!ut.primaryPlanAssetId && l.plan) ut.primaryPlanAssetId = l.plan.assetId;
  }
  return { levels, warnings, northDeg, unitTypes: types, planAssetIds };
}

function planOutToLevel(
  out: PlanLevelOut,
  ctx: { levelId: string; pageN: number; img: { id: string; path: string; w: number; h: number }; heightM: number; ceilingFact?: { value: number; evidence: Evidence } },
): Level {
  const { levelId, pageN, img } = ctx;
  const b = out.planBoundsPx;
  const pxPerM = out.pxPerMeter && out.pxPerMeter > 0 ? out.pxPerMeter : img.w / 20;
  // convert whatever came back into plan metres with origin at the drawn plan's bottom-left
  const toM = (v: { x: number; y: number }) => (out.units === "meters" ? { x: round(v.x), y: round(v.y) } : { x: round((v.x - b.x0) / pxPerM), y: round((b.y1 - v.y) / pxPerM) });
  const conf = out.scaleConfidence;
  const ev = (quote: string, c = conf, bbox?: number[]): Evidence => ({ source: "pdf", ref: `page-${pageN}`, quote, bbox: bbox?.length === 4 ? (bbox as [number, number, number, number]) : undefined, confidence: Math.max(0.05, Math.min(1, c)) });
  const rooms: Room[] = out.rooms.map((r, i) => ({
    id: `${levelId}-r${i + 1}`,
    name: r.name,
    program: r.program,
    polygon: r.polygon.map(toM),
    areaM2: r.printedAreaM2 ?? (r.printedDimensions ? areaFromDims(r.printedDimensions) : undefined),
    ceilingHeightM: ctx.ceilingFact?.value,
    levelId,
    adjacentRoomIds: [],
    evidence: [
      ...(r.printedDimensions ? [ev(`${r.name} ${r.printedDimensions}`, 0.85)] : [ev(r.name, 0.7)]),
      ...r.evidence.map((e) => ev(e.quote, e.confidence, e.bbox)),
    ],
  }));
  const walls: Wall[] = out.walls.map((w, i) => {
    const id = `${levelId}-w${i + 1}`;
    const th = out.units === "meters" ? w.thickness : w.thickness / pxPerM;
    return {
      id,
      a: toM(w.a),
      b: toM(w.b),
      thicknessM: round(Math.max(0.05, Math.min(0.6, th || 0.15)), 3),
      heightM: w.kind === "railing" ? 1.1 : ctx.heightM,
      kind: w.kind,
      openings: w.openings.map((o, k) => ({
        id: `${id}-o${k + 1}`, kind: o.kind, wallId: id, offset: Math.min(1, Math.max(0, o.offset)),
        widthM: round(Math.max(0.5, out.units === "meters" ? o.width : o.width / pxPerM), 3),
        heightM: o.kind === "window" ? 1.5 : 2.2,
        sillM: o.kind === "window" ? undefined : 0,
        evidence: [ev(`${o.kind} traced from plan`, conf * 0.8)],
      })),
      evidence: [ev(`wall traced from plan (${out.scaleSource})`)],
    };
  });
  const furniture: Furniture[] = out.furniture.map((f, i) => ({
    id: `${levelId}-f${i + 1}`, kind: f.kind, center: toM(f.center),
    sizeM: { w: out.units === "meters" ? f.w : f.w / pxPerM, d: out.units === "meters" ? f.d : f.d / pxPerM, h: furnitureHeight(f.kind) },
    rotationDeg: f.rotationDeg, evidence: [ev(`${f.kind} shown on furniture layout`, conf * 0.7)],
  }));
  return {
    id: levelId,
    name: canonicalLevelName(out.levelName),
    elevationM: 0,
    heightM: ctx.heightM,
    rooms, walls, furniture,
    plan: {
      assetId: img.id, imagePath: img.path, imageW: img.w, imageH: img.h,
      pxPerM: round(out.units === "meters" && !out.pxPerMeter ? img.w / 20 : pxPerM, 3),
      originPx: { x: b.x0, y: b.y1 },
      scaleConfidence: conf,
      evidence: [ev(`scale: ${out.scaleSource}`), ...out.dimensionStrings.slice(0, 40).map((d) => ev(d, 0.8))],
    },
  };
}

function furnitureHeight(kind: string) {
  return ({ bed_double: 0.55, bed_single: 0.5, sofa: 0.8, armchair: 0.8, dining: 0.76, desk: 0.75, kitchen_run: 0.92, island: 0.92, wardrobe: 2.4, bath: 0.6, wc: 0.4, vanity: 0.85 } as Record<string, number>)[kind] ?? 0.8;
}

/** "4.2 X 2.4" → 10.08; "3850 x 4200" (mm) → 16.17 */
export function areaFromDims(s: string): number | undefined {
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*[x×X]\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return undefined;
  let a = Number(m[1].replace(",", ".")), b = Number(m[2].replace(",", "."));
  if (a > 100) a /= 1000;
  if (b > 100) b /= 1000;
  return round(a * b, 2);
}
