// Stage 3A: text facts. Every paragraph is kept (dossier.copy); numeric values, areas,
// prices, dates, unit types, views and disclaimers become facts with page evidence.
import type { Evidence, Fact, PageRecord, UnitType } from "./schema";
import { SQFT_PER_M2 } from "./geom";
import { callStructured, FACTS_SYSTEM, FactsSchema } from "./llm";

export type FactsOut = {
  projectName?: string;
  developer?: string;
  location?: string;
  copy: string[];
  facts: Fact[];
  unitTypes: UnitType[];
  warnings: string[];
};

const num = (s: string) => {
  // "1,580" → 1580 ; "2,5" (European decimal) → 2.5 ; "1.367,44" → 1367.44
  const t = s.trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, "").replace(",", "."));
  if (/^\d+,\d{1,2}$/.test(t)) return Number(t.replace(",", "."));
  return Number(t.replace(/,/g, ""));
};

function evFor(p: PageRecord, quote: string, confidence = 0.8): Evidence {
  const q = quote.trim();
  const item = p.items.find((i) => i.str.includes(q.split("\n")[0].slice(0, 30)) || q.includes(i.str.trim()) && i.str.trim().length > 3);
  return { source: p.textSource === "html" ? "url" : "pdf", ref: `page-${p.n}`, quote: q.slice(0, 300), bbox: item?.bbox, confidence: p.textSource === "ocr" ? Math.min(confidence, 0.6) : confidence };
}

const AREA_LABEL = /(built[\s-]*up(\s*area)?|\bbua\b|\bgfa\b|\bnfa\b|plot(\s*area)?|suite(\s*area)?|internal(\s*area)?|balcony(\s*area)?|terrace(\s*area)?|total(\s*area)?|saleable(\s*area)?|land\s*area|area\s*sq\.?\s*(meter|metre|m)|area\s*sq\.?\s*(feet|ft)|area)/i;
const RECORD_LABELS = /\b(issue\s*date|mortgage\s*status|property\s*type|community|district|plot\s*no|municipality\s*no|area\s*sq\.?\s*(?:meter|metre|m)|area\s*sq\.?\s*(?:feet|ft)|registration\s*no|unit\s*no|building\s*name|floor\s*no)\b\.?/i;

const KEY_OF: Array<[RegExp, string]> = [
  [/built|bua/i, "bua"], [/gfa/i, "gfa"], [/nfa/i, "nfa"], [/plot|land/i, "plot"], [/suite|internal/i, "suite"],
  [/balcony/i, "balcony"], [/terrace/i, "terrace"], [/total|saleable/i, "total"], [/area/i, "area"],
];

export function localFacts(pages: PageRecord[], sourceMeta: Array<Record<string, string> | undefined>): FactsOut {
  const facts: Fact[] = [];
  const warnings: string[] = [];
  const copy: string[] = [];
  const unitTypes: UnitType[] = [];
  const addFact = (key: string, value: string, e: Evidence) => {
    const existing = facts.find((f) => f.key === key && f.value === value);
    if (existing) existing.evidence.push(e);
    else facts.push({ key, value, evidence: [e] });
  };

  for (const p of pages) {
    const lines = p.text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    // every paragraph, verbatim
    for (const para of p.text.split(/\n{2,}/).map((s) => s.replace(/\s*\n\s*/g, " ").trim()).filter((s) => s.length > 2)) copy.push(`[p${p.n}] ${para}`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = lines[i - 1] ?? "";
      // areas: "1,580 SQM / 17,012 SQFT", "Area Sq Meter : 1367.44", "Suite 108.5 m²"
      const pair = /area\s*sq/i.test(line) ? null : line.match(/([\d.,]+)\s*(sq\.?\s*m|sqm|m²|m2)\b[^\d]{0,6}([\d.,]+)\s*(sq\.?\s*ft|sqft|ft²|ft2)/i);
      const single = line.match(/([\d.,]+)\s*(sq\.?\s*m|sqm|m²|m2|sq\.?\s*ft|sqft|ft²|ft2)\b/i);
      const labelled = RECORD_LABELS.test(line) ? null : line.match(/(area\s*sq\.?\s*(meter|metre|feet|ft))\s*[:：]?\s*([\d.,]+)/i);
      const labelSrc = AREA_LABEL.test(line) ? line : AREA_LABEL.test(prev) ? prev : "";
      const base = KEY_OF.find(([re]) => re.test(labelSrc))?.[1] ?? "area";
      if (pair) {
        const m2 = num(pair[1]), ft2 = num(pair[3]);
        const quote = labelSrc && labelSrc !== line ? `${labelSrc}\n${line}` : line;
        addFact(`area.${base}_m2`, String(m2), evFor(p, quote));
        addFact(`area.${base}_sqft`, String(ft2), evFor(p, quote));
        const conv = m2 * SQFT_PER_M2;
        if (Math.abs(conv - ft2) / ft2 > 0.02) warnings.push(`Page ${p.n}: ${base.toUpperCase()} ${m2} m² ≠ ${ft2} sq ft (converts to ${conv.toFixed(0)} sq ft).`);
      } else if (labelled) {
        const v = num(labelled[3]);
        const unit = /feet|ft/i.test(labelled[2]) ? "sqft" : "m2";
        addFact(`area.${base === "area" ? "land" : base}_${unit}`, String(v), evFor(p, line, 0.75));
      } else if (single && labelSrc) {
        const v = num(single[1]);
        const unit = /ft/i.test(single[2]) ? "sqft" : "m2";
        addFact(`area.${base}_${unit}`, String(v), evFor(p, labelSrc !== line ? `${labelSrc}\n${line}` : line));
      }
      // prices (stored as printed — never displayed as confirmed)
      for (const m of line.matchAll(/(?:aed\s*)?(\d{1,3}(?:,\d{3}){2,}|\d{7,})(?:\s*aed)?/gi)) {
        if (!/aed|price|cost|pay|sale|instal|paid|dirham|amount/i.test(line + " " + prev)) continue;
        const key = /original/i.test(line + prev) ? "price.original_aed" : /market|developer/i.test(line + prev) ? "price.developer_market_aed" : /paid/i.test(line + prev) ? "price.paid_aed" : /seller|total to pay/i.test(line + prev) ? "price.to_seller_aed" : /installment|instalment/i.test(line + prev) ? "price.installment_aed" : "price.as_printed_aed";
        addFact(key, `${m[1]} (as printed, unconfirmed)`, evFor(p, prev && !/\d/.test(prev) ? `${prev}\n${line}` : line, 0.6));
      }
      const pct = line.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/);
      if (pct && /below|discount|paid|plan|%/i.test(line + prev) && /[a-z]/i.test(line + prev)) addFact(`percent.${(prev || line).toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "value"}`, pct[0], evFor(p, `${prev}\n${line}`, 0.6));
      const plan = line.match(/\b(\d{2})\s*\/\s*(\d{2})\b/);
      if (plan && /payment\s*plan/i.test(prev + line)) addFact("payment_plan", `${plan[1]}/${plan[2]}`, evFor(p, `${prev}\n${line}`));
      // beds / type / handover / service charge / ceilings / views / location
      const beds = line.match(/\b(\d)\s*(?:bed(?:room)?s?|br)\b/i);
      if (beds) addFact("beds", beds[1], evFor(p, line));
      const vt = line.match(/\b((?:villa|unit|apartment|townhouse)?\s*type\s*[a-z0-9-]{1,4})\b/i);
      if (vt && /type/i.test(vt[1])) addFact("unit.type", vt[1].replace(/\s+/g, " ").trim().toUpperCase(), evFor(p, line));
      if (/\b[BG]\s*\+\s*[G\d](\s*\+\s*\d)?\b/i.test(line)) addFact("storeys", line.match(/\b[BG]\s*\+\s*[G\d](\s*\+\s*\d)?\b/i)![0].replace(/\s/g, ""), evFor(p, line));
      if (/standalone|detached|semi-detached|townhouse|penthouse|duplex/i.test(line)) addFact("building_form", line.match(/standalone|detached|semi-detached|townhouse|penthouse|duplex/i)![0].toLowerCase(), evFor(p, line));
      if (/handover|completion/i.test(prev + " " + line)) {
        const d = line.match(/\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?|q[1-4])\s*\d{4}\b/i);
        if (d) addFact("handover", d[0].toUpperCase(), evFor(p, `${prev}\n${line}`));
      }
      if (/service\s*charge/i.test(prev + " " + line)) {
        const sc = line.match(/([\d.,]+)\s*aed\s*\/\s*(sq\.?\s*ft|sqft)/i);
        if (sc) addFact("service_charge_aed_per_sqft", String(num(sc[1])), evFor(p, `${prev}\n${line}`));
      }
      const ceil = line.match(/(\d(?:[.,]\d{1,2})?)\s*m\b[^.\n]{0,20}(clear\s*height|ceiling|floor[- ]to[- ](ceiling|floor))/i);
      if (ceil) addFact("ceiling_height_m", String(num(ceil[1])), evFor(p, line, 0.9));
      const view = line.match(/\b(views?\s+(of|to|over)|facing|overlooking|backing\s+on\s*to|fronting)\b.{3,60}/i);
      if (view) addFact("view_claim", line, evFor(p, line, 0.7));
      const loc = line.match(/^location\b[:\s]*(.+)$/i);
      if (loc) addFact("location", loc[1].trim(), evFor(p, line, 0.85));
      // registry-style "Label: value" records, including bilingual EN/AR lines where OCR reorders the parts
      const rec = line.match(RECORD_LABELS);
      if (rec && (/[:：]/.test(line) || line.replace(/[\s\u200e\u200f]+$/, "").toLowerCase().endsWith(rec[0].toLowerCase().trim()))) {
        const key = rec[1].toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
        const ar = (line.match(/[؀-ۿ][؀-ۿ\s\d/.-]*/g) ?? []).join(" ").replace(/\s+/g, " ").trim();
        const en = line.replace(/[؀-ۿ‎‏]+/g, " ").replace(rec[0], " ").replace(/[:：]/g, " ").replace(/\s+/g, " ").trim();
        const value = [en, ar && !/^[\d\s/.-]*$/.test(ar) ? `(${ar})` : ""].filter(Boolean).join(" ");
        if (value) addFact(`record.${key}`, value, evFor(p, line, 0.65));
        if (/area\s*sq/i.test(rec[1])) {
          const v = en.match(/[\d.,]+/);
          if (v) addFact(`area.land_${/feet|ft/i.test(rec[1]) ? "sqft" : "m2"}`, String(num(v[0])), evFor(p, line, 0.7));
        }
      }
      if (/disclaimer|subject\s*to\s*change|artist'?s?\s*impression|for\s*illustration|indicative\s*only|not\s*to\s*scale/i.test(line)) warnings.push(`Page ${p.n}: "${line.slice(0, 140)}"`);
    }
    if (p.languages.includes("ar")) addFact("languages", "EN + AR", { source: "pdf", ref: `page-${p.n}`, quote: "Arabic text present", confidence: 0.9 });
  }

  // project name: PDF metadata title, else the most repeated heading line across pages
  let projectName: string | undefined;
  const titled = sourceMeta.find((m) => m?.Title && m.Title.length > 2 && !/untitled|microsoft|canva/i.test(m.Title));
  if (titled) projectName = titled.Title;
  const heads = new Map<string, number>();
  for (const p of pages) for (const l of p.text.split("\n").slice(0, 3)) {
    const k = l.trim();
    if (k.length > 5 && k.length < 50 && /[A-Z]{3}/.test(k) && !/\d{3}/.test(k)) heads.set(k, (heads.get(k) ?? 0) + 1);
  }
  const repeated = [...heads.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!projectName && repeated) projectName = repeated;
  if (projectName) addFact("project.name", projectName, { source: "pdf", ref: titled ? "metadata:Title" : "headings", quote: projectName, confidence: titled ? 0.7 : 0.5 });
  if (repeated && repeated !== projectName) addFact("project.heading", repeated, { source: "pdf", ref: "headings", quote: repeated, confidence: 0.6 });

  const location = facts.find((f) => f.key === "location")?.value ?? facts.find((f) => f.key === "record.community")?.value;

  // unit types: explicit "Type X" codes; beds/areas attached when printed on the same page
  const types = facts.filter((f) => f.key === "unit.type");
  for (const t of types) {
    const pagesOf = new Set(t.evidence.map((e) => e.ref));
    const near = (key: string) => facts.find((f) => f.key === key && f.evidence.some((e) => pagesOf.has(e.ref)));
    const beds = near("beds");
    unitTypes.push({
      id: `ut-${t.value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      code: t.value,
      beds: beds ? Number(beds.value) : undefined,
      suiteAreaM2: near("area.suite_m2") ? Number(near("area.suite_m2")!.value) : undefined,
      balconyAreaM2: near("area.balcony_m2") ? Number(near("area.balcony_m2")!.value) : undefined,
      // villas quote built-up area (BUA); apartments quote suite + balcony = total
      totalAreaM2: near("area.total_m2") ? Number(near("area.total_m2")!.value) : near("area.bua_m2") ? Number(near("area.bua_m2")!.value) : undefined,
      levelIds: [],
    });
  }
  // m² vs sq ft printed side by side must agree (1 m² = 10.7639 sq ft)
  for (const f of facts.filter((x) => /^area\..+_m2$/.test(x.key))) {
    const ft = facts.find((x) => x.key === f.key.replace(/_m2$/, "_sqft"));
    if (!ft) continue;
    const conv = Number(f.value) * SQFT_PER_M2;
    if (Math.abs(conv - Number(ft.value)) / Number(ft.value) > 0.02) warnings.push(`${f.key}: ${f.value} m² converts to ${conv.toFixed(0)} sq ft, but ${ft.value} sq ft is printed.`);
  }
  // conflicting values for the same key (e.g. two different BUAs) are surfaced, never averaged
  const byKey = new Map<string, Fact[]>();
  for (const f of facts) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  for (const [k, fs] of byKey) if (fs.length > 1 && /^area\.|ceiling|beds$/.test(k)) warnings.push(`Conflicting ${k}: ${fs.map((f) => `${f.value} (${f.evidence[0].ref})`).join(" vs ")}. Geometry uses the brochure value; please confirm.`);

  return { projectName, location, copy, facts, unitTypes, warnings: [...new Set(warnings)] };
}

export async function claudeFacts(jobId: string, pages: PageRecord[]): Promise<Omit<FactsOut, "copy">> {
  const text = pages.map((p) => `=== page-${p.n} (${p.textSource}) ===\n${p.text}`).join("\n\n");
  const out = await callStructured(jobId, { task: "facts", system: FACTS_SYSTEM, schema: FactsSchema, schemaName: "Facts", prompt: text.slice(0, 400_000) });
  const byRef = new Map(pages.map((p) => [`page-${p.n}`, p]));
  const facts: Fact[] = out.facts.map((f) => {
    const p = byRef.get(f.pageRef);
    return { key: f.key, value: /^price\./.test(f.key) ? `${f.value} (as printed, unconfirmed)` : f.value, evidence: [p ? evFor(p, f.quote, 0.75) : { source: "pdf", ref: f.pageRef, quote: f.quote, confidence: 0.6 }] };
  });
  return {
    projectName: out.projectName ?? undefined,
    developer: out.developer ?? undefined,
    location: out.location ?? undefined,
    facts,
    unitTypes: out.unitTypes.map((u) => ({
      id: `ut-${u.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, code: u.code, beds: u.beds ?? undefined, baths: u.baths ?? undefined,
      suiteAreaM2: u.suiteAreaM2 ?? undefined, balconyAreaM2: u.balconyAreaM2 ?? undefined, totalAreaM2: u.totalAreaM2 ?? undefined, levelIds: [],
    })),
    warnings: out.disclaimers.map((d) => `Disclaimer: "${d}"`),
  };
}
