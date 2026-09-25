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
import { limiter, settle, MODEL_CONCURRENCY } from "./concurrency";
import { callStructured, KEY_PLAN_SYSTEM, KeyPlanSchema, PLAN_SYSTEM, PlanLevelSchema, type KeyPlanOut, type PlanLevelOut } from "./llm";
import { hamming } from "./image-stats";
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
  onLevel?: (levels: Level[]) => Promise<void>,
): Promise<{ levels: Level[]; warnings: string[]; northDeg?: number; unitTypes: UnitType[]; planAssetIds: string[] }> {
  const warnings: string[] = [];
  const levels: Level[] = [];
  const planAssetIds: string[] = [];
  let northDeg: number | undefined;
  const planPages = pages.filter((p) => p.labels.some((l) => l === "unit_plan" || l === "typical_floor" || l === "furniture_layout"));
  const keyPlans = assets.filter((a) => a.kind === "key_plan");
  if (!planPages.length && keyPlans.length) {
    // no floor plan anywhere: the key plans beside the renders are the only drawings of the rooms
    const kp = await keyPlanLevels(jobId, pages, assets, keyPlans, useClaude, ceilingFact, onLevel);
    levels.push(...kp.levels);
    warnings.push(...kp.warnings);
    planAssetIds.push(...keyPlans.map((a) => a.id));
  } else if (!planPages.length) warnings.push("No floor plan found. Add the unit plan page or another brochure to reconstruct geometry.");

  const planImgsFor = (p: PageRecord) => {
    const crops = assets.filter((a) => a.page === p.n && (a.kind === "unit_plan" || a.kind === "floor_plan"));
    const imgs: Array<{ id: string; path: string; bbox: [number, number, number, number]; w: number; h: number }> =
      crops.length ? crops : assets.filter((a) => a.page === p.n && a.origin !== "pdf_crop").map((a) => ({ ...a, bbox: [0, 0, 1, 1] as [number, number, number, number] }));
    if (!imgs.length) imgs.push({ id: `a${p.n}-page`, path: p.image, bbox: [0, 0, 1, 1], w: p.widthPx, h: p.heightPx });
    return imgs;
  };

  // start every plan's model call up front, a few at a time; levels are then assembled in page order
  const run = limiter(MODEL_CONCURRENCY);
  const modelOut = new Map<string, ReturnType<typeof settle<PlanLevelOut>>>();
  if (useClaude) {
    for (const p of planPages) {
      planImgsFor(p).forEach((img, i) => {
        const levelId = `L-p${p.n}-${i + 1}`;
        modelOut.set(levelId, settle(run(() => callStructured(jobId, {
          task: `plan ${levelId}`, system: PLAN_SYSTEM, schema: PlanLevelSchema, schemaName: "Level",
          prompt: `This is a plan image cut from brochure page ${p.n}. Nearby text on the page:\n"""\n${p.text.slice(0, 3000)}\n"""\nReturn the level geometry.`,
          images: [jobFile(jobId, img.path)],
        }))));
      });
    }
  }

  for (const p of planPages) {
    const planImgs = planImgsFor(p);
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
          const r = await modelOut.get(levelId)!;
          if (!r.ok) throw r.error;
          const out = r.value;
          const lvl = planOutToLevel(out, { levelId, pageN: p.n, img, heightM, ceilingFact });
          if (out.northArrowDeg !== null && northDeg === undefined) northDeg = out.northArrowDeg;
          if (lvl.plan!.scaleConfidence < 0.4) warnings.push(`${lvl.name}: scale not proven (${out.scaleSource}). Calibrate from a printed dimension in the plan editor.`);
          levels.push(lvl);
          await log(jobId, "extract", `${lvl.name}: ${lvl.rooms.length} room(s), ${lvl.walls.length} wall(s) from vision model (scale confidence ${out.scaleConfidence.toFixed(2)}).`);
          await onLevel?.(levels);
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

/** "Ground floor - Formal living" → { floor: "Ground floor", room: "Formal living" } */
export function captionFloorRoom(caption?: string): { floor: string; room: string } | undefined {
  const m = caption?.match(/^\s*((?:lower\s+|upper\s+)?(?:basement|ground|first|second|third|fourth|roof\s*top|rooftop|roof|mezzanine|podium|level\s*\d+|\d+(?:st|nd|rd|th))(?:\s*floor)?)\s*[-–:|]\s*(.+?)\s*$/i);
  if (!m) return undefined;
  return { floor: m[1].replace(/\s+/g, " ").replace(/^\w/, (c) => c.toUpperCase()), room: m[2].replace(/\s+/g, " ") };
}

const KEY_PLAN_GAP_M = 0.4;
/** key plans on a floor are packed in rows no wider than this, so the floor reads as one compact house */
const KEY_PLAN_ROW_M = 17;

/**
 * Levels from key plans (the crop of the architect's plan printed beside each render) when the sources have no floor
 * plan. The same key plan is often printed beside several renders of one room with only the camera marker moved: those
 * are traced once. Each distinct key plan becomes a group of rooms on its floor, set side by side, because where the
 * rooms sit on the floor is not documented. The camera markers become render viewpoints for the walkthrough.
 */
async function keyPlanLevels(
  jobId: string, pages: PageRecord[], assets: LabelledAsset[], keyPlans: LabelledAsset[], useClaude: boolean,
  ceilingFact: { value: number; evidence: Evidence } | undefined, onLevel?: (levels: Level[]) => Promise<void>,
): Promise<{ levels: Level[]; warnings: string[] }> {
  const warnings: string[] = [];
  const heightM = ceilingFact?.value ?? DEFAULT_CEILING_M;
  const pageOf = (n?: number) => pages.find((p) => p.n === n);
  type Group = { rep: LabelledAsset; members: LabelledAsset[]; floor: string; rooms: string[] };
  const groups: Group[] = [];
  for (const a of [...keyPlans].sort((x, y) => (x.page ?? 0) - (y.page ?? 0))) {
    const cf = captionFloorRoom(pageOf(a.page)?.caption);
    const floor = cf?.floor ?? "Unassigned";
    const g = groups.find((x) => x.floor === floor && hamming(x.rep.hash, a.hash) <= 12);
    if (g) {
      g.members.push(a);
      if (cf && !g.rooms.includes(cf.room)) g.rooms.push(cf.room);
    } else groups.push({ rep: a, members: [a], floor, rooms: cf ? [cf.room] : [] });
  }
  if (!useClaude) {
    warnings.push(`No floor plan: ${groups.length} key plan(s) beside the renders can be traced by a vision model (set an extractor) or by hand in the plan editor.`);
    return { levels: [], warnings };
  }
  const run = limiter(MODEL_CONCURRENCY);
  const outs = await Promise.all(groups.map((g) => settle(run(() => {
    const pagesList = g.members.map((m) => m.page).join(", ");
    return callStructured(jobId, {
      task: `key plan p${g.rep.page}`, system: KEY_PLAN_SYSTEM, schema: KeyPlanSchema, schemaName: "KeyPlan",
      prompt: [
        `Key plan printed beside the render${g.members.length > 1 ? "s" : ""} on page${g.members.length > 1 ? "s" : ""} ${pagesList}.`,
        `Caption${g.members.length > 1 ? "s" : ""}: ${[...new Set(g.members.map((m) => pageOf(m.page)?.caption).filter(Boolean))].join(" / ")}. Floor: ${g.floor}.`,
        g.members.length > 1 ? `Image 1 is the key plan from page ${g.rep.page}; images 2-${g.members.length} are the same key plan from pages ${g.members.slice(1).map((m) => m.page).join(", ")}, where only the camera marker moves. Trace the rooms on image 1 and give every image's camera marker at its spot on image 1's drawing, with its page.` : "",
      ].filter(Boolean).join("\n"),
      images: g.members.map((m) => jobFile(jobId, m.path)),
    });
  }))));

  const byFloor = new Map<string, Level & { cursor: number; rowY: number; rowH: number }>();
  let n = 0;
  for (const [gi, g] of groups.entries()) {
    const r = await outs[gi];
    if (!r.ok) {
      warnings.push(`Key plan on page ${g.rep.page} (${g.rooms.join(", ") || g.floor}) not traced yet: ${r.error instanceof Error ? r.error.message : r.error}`);
      continue;
    }
    const out = r.value as KeyPlanOut;
    const frag = planOutToLevel(out, { levelId: `kp${gi}`, pageN: g.rep.page!, img: g.rep, heightM, ceilingFact });
    // evidence boxes come back in key-plan coordinates: map them onto the page
    const kb = g.rep.bbox;
    const toPage = (e: Evidence): Evidence => (e.bbox ? { ...e, bbox: [kb[0] + e.bbox[0] * (kb[2] - kb[0]), kb[1] + e.bbox[1] * (kb[3] - kb[1]), kb[0] + e.bbox[2] * (kb[2] - kb[0]), kb[1] + e.bbox[3] * (kb[3] - kb[1])] } : { ...e, bbox: kb });
    const floorName = canonicalLevelName(g.floor);
    const levelId = `L-kp-${floorName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    let L = byFloor.get(floorName);
    if (!L) {
      L = { id: levelId, name: floorName, elevationM: 0, heightM, rooms: [], walls: [], furniture: [], layout: "key_plans", renderViews: [], cursor: 0, rowY: 0, rowH: 0 };
      byFloor.set(floorName, L);
    }
    const xs = [...frag.rooms.flatMap((q) => q.polygon.map((p) => p.x)), ...frag.walls.flatMap((w) => [w.a.x, w.b.x])];
    const ys = [...frag.rooms.flatMap((q) => q.polygon.map((p) => p.y)), ...frag.walls.flatMap((w) => [w.a.y, w.b.y])];
    if (!xs.length) continue;
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // a key plan whose rooms are already on this floor is a repeat of a drawing traced before: only its cameras are new
    const base = (s: string) => s.replace(/\s*\(part\)\s*$/i, "").trim().toLowerCase();
    const whole = frag.rooms.filter((q) => !/\(part\)\s*$/i.test(q.name));
    const repeat = whole.length > 0 && whole.every((q) => L!.rooms.some((x) => base(x.name) === base(q.name)));
    // shelf packing: next to the previous key plan, or at the start of a new row when this one would overflow it
    const wide = maxX - minX, tall = maxY - minY;
    if (!repeat && L.cursor > 0 && L.cursor + wide > KEY_PLAN_ROW_M) { L.cursor = 0; L.rowY += L.rowH + KEY_PLAN_GAP_M; L.rowH = 0; }
    let dx = L.cursor - minX, dy = L.rowY - minY;
    if (repeat) {
      const q = whole[0], x = L.rooms.find((y) => base(y.name) === base(q.name))!;
      const c = (poly: { x: number; y: number }[]) => ({ x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length });
      const [c1, c0] = [c(x.polygon), c(q.polygon)];
      dx = c1.x - c0.x;
      dy = c1.y - c0.y;
    }
    const sh = (p: { x: number; y: number }) => ({ x: round(p.x + dx), y: round(p.y + dy) });
    const toM = (v: { x: number; y: number }) => {
      if (out.units === "meters") return v;
      const b = out.planBoundsPx, ppm = out.pxPerMeter && out.pxPerMeter > 0 ? out.pxPerMeter : g.rep.w / 20;
      return { x: (v.x - b.x0) / ppm, y: (b.y1 - v.y) / ppm };
    };
    for (const cam of out.cameras) {
      const page = cam.page ?? g.rep.page!;
      const render = assets.find((a) => a.page === page && (a.kind === "cgi_interior" || a.kind === "cgi_exterior"));
      L.renderViews!.push({ page, caption: pageOf(page)?.caption, renderAssetId: render?.id, at: sh(toM(cam.at)), look: sh(toM(cam.look)) });
    }
    if (repeat) continue;
    for (const q of frag.rooms) L.rooms.push({ ...q, id: `${levelId}-r${++n}`, levelId, polygon: q.polygon.map(sh), evidence: q.evidence.map(toPage) });
    for (const w of frag.walls) {
      const id = `${levelId}-w${++n}`;
      L.walls.push({ ...w, id, a: sh(w.a), b: sh(w.b), evidence: w.evidence.map(toPage), openings: w.openings.map((o, k) => ({ ...o, id: `${id}-o${k + 1}`, wallId: id, evidence: o.evidence.map(toPage) })) });
    }
    for (const f of frag.furniture ?? []) L.furniture!.push({ ...f, id: `${levelId}-f${++n}`, center: sh(f.center), evidence: f.evidence.map(toPage) });
    L.cursor += wide + KEY_PLAN_GAP_M;
    L.rowH = Math.max(L.rowH, tall);
    await log(jobId, "extract", `${floorName}: key plan p${g.rep.page} traced (${frag.rooms.length} room(s), scale from ${out.scaleSource}).`);
  }
  const levels = [...byFloor.values()].map(({ cursor: _c, rowY: _y, rowH: _h, ...l }) => l as Level);
  if (levels.length) {
    await onLevel?.(levels);
    warnings.push("No floor plan was published for this property. Rooms are traced from the key plans printed beside the renders; key plans print no dimensions, so their scale comes from standard door and furniture sizes. Rooms on a floor are packed together: where they sit on the floor is not documented.");
  }
  return { levels, warnings };
}
