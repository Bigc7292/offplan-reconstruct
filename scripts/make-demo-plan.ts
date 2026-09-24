// Renders the DEMO unit's sales-style floor plan to public/samples/demo-unit-plan.svg.
// Run: npx tsx scripts/make-demo-plan.ts
// The drawing is generated from the same demo dossier, so the plan overlay aligns exactly.
import fs from "node:fs";
import path from "node:path";
import { buildDemoDossier, DEMO_PLAN_ORIGIN, DEMO_PLAN_PX_PER_M } from "../src/lib/demo";
import { labelPoint, polygonArea } from "../src/lib/geom";

const d = buildDemoDossier("demo");
const L = d.levels[0];
const S = DEMO_PLAN_PX_PER_M;
const O = DEMO_PLAN_ORIGIN;
const W = L.plan!.imageW, H = L.plan!.imageH;
const X = (x: number) => (O.x + x * S).toFixed(1);
const Y = (y: number) => (O.y - y * S).toFixed(1);

const out: string[] = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`);
out.push(`<rect width="100%" height="100%" fill="#fbfaf7"/>`);
for (const r of L.rooms) {
  const fill = r.program === "balcony" ? "#e9efe6" : r.program === "bath" ? "#eef1f3" : "#f6f1e8";
  out.push(`<polygon points="${r.polygon.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}" fill="${fill}"/>`);
}
for (const w of L.walls) {
  const th = Math.max(2, w.thicknessM * S);
  const color = w.kind === "glass" || w.kind === "railing" ? "#6f94a0" : "#2a2622";
  const Lw = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const ux = (w.b.x - w.a.x) / Lw, uy = (w.b.y - w.a.y) / Lw;
  // draw solid spans, leaving gaps at openings
  const ops = [...w.openings].sort((a, b) => a.offset - b.offset);
  let t = 0;
  const spans: Array<[number, number]> = [];
  for (const o of ops) {
    const c = o.offset * Lw;
    spans.push([t, c - o.widthM / 2]);
    t = c + o.widthM / 2;
  }
  spans.push([t, Lw]);
  for (const [s, e] of spans) {
    if (e - s < 0.01) continue;
    out.push(`<line x1="${X(w.a.x + ux * s)}" y1="${Y(w.a.y + uy * s)}" x2="${X(w.a.x + ux * e)}" y2="${Y(w.a.y + uy * e)}" stroke="${color}" stroke-width="${th.toFixed(1)}" stroke-linecap="square"/>`);
  }
  for (const o of ops) {
    const c = o.offset * Lw;
    const s = c - o.widthM / 2, e = c + o.widthM / 2;
    const ax = w.a.x + ux * s, ay = w.a.y + uy * s, bx = w.a.x + ux * e, by = w.a.y + uy * e;
    if (o.kind === "window" || o.kind === "sliding_door") {
      out.push(`<line x1="${X(ax)}" y1="${Y(ay)}" x2="${X(bx)}" y2="${Y(by)}" stroke="#6f94a0" stroke-width="3"/>`);
    } else if (o.kind === "door") {
      const nx = -uy, ny = ux;
      const r = o.widthM;
      out.push(`<path d="M${X(ax)},${Y(ay)} L${X(ax + nx * r)},${Y(ay + ny * r)} A${(r * S).toFixed(1)},${(r * S).toFixed(1)} 0 0,1 ${X(bx)},${Y(by)}" fill="none" stroke="#8a847b" stroke-width="1.2"/>`);
    }
  }
}
for (const r of L.rooms) {
  const p = labelPoint(r.polygon);
  const xs = r.polygon.map((q) => q.x), ys = r.polygon.map((q) => q.y);
  const dims = `${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} × ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)}`;
  const wPx = (Math.max(...xs) - Math.min(...xs)) * S - 8;
  const words = r.name.toUpperCase().split(/\s+/);
  const lines = words.join(" ").length * 7.2 > wPx && words.length > 1 ? words : [words.join(" ")];
  const fs1 = Math.min(12, wPx / (Math.max(...lines.map((l) => l.length)) * 0.68));
  lines.forEach((ln, i) => out.push(`<text x="${X(p.x)}" y="${(+Y(p.y) - (lines.length - 1) * 7 + i * 13).toFixed(1)}" text-anchor="middle" font-size="${fs1.toFixed(1)}" font-weight="600" fill="#2a2622">${ln}</text>`));
  const fs2 = Math.min(10, wPx / (dims.length * 0.6));
  out.push(`<text x="${X(p.x)}" y="${(+Y(p.y) + 8 + lines.length * 6).toFixed(1)}" text-anchor="middle" font-size="${fs2.toFixed(1)}" fill="#6b645a">${dims}</text>`);
  out.push(`<text x="${X(p.x)}" y="${(+Y(p.y) + 20 + lines.length * 6).toFixed(1)}" text-anchor="middle" font-size="${fs2.toFixed(1)}" fill="#6b645a">${polygonArea(r.polygon).toFixed(1)} m²</text>`);
}
// overall dimension strings
out.push(`<line x1="${X(0)}" y1="${+Y(8.6) - 30}" x2="${X(13.4)}" y2="${+Y(8.6) - 30}" stroke="#6b645a" stroke-width="1"/>`);
out.push(`<text x="${X(6.7)}" y="${+Y(8.6) - 36}" text-anchor="middle" font-size="11" fill="#6b645a">13400</text>`);
out.push(`<line x1="${+X(13.4) + 30}" y1="${Y(0)}" x2="${+X(13.4) + 30}" y2="${Y(8.6)}" stroke="#6b645a" stroke-width="1"/>`);
out.push(`<text x="${+X(13.4) + 40}" y="${Y(4.3)}" font-size="11" fill="#6b645a" transform="rotate(90 ${+X(13.4) + 40} ${Y(4.3)})" text-anchor="middle">8600</text>`);
// scale bar 0-5 m
const sbY = H - 22;
out.push(`<g><rect x="${O.x}" y="${sbY}" width="${5 * S}" height="6" fill="none" stroke="#2a2622"/>`);
for (let i = 0; i < 5; i += 2) out.push(`<rect x="${O.x + i * S}" y="${sbY}" width="${S}" height="6" fill="#2a2622"/>`);
out.push(`<text x="${O.x - 4}" y="${sbY + 6}" font-size="10" text-anchor="end">0</text><text x="${O.x + 5 * S + 4}" y="${sbY + 6}" font-size="10">5 m</text></g>`);
// north arrow (north up)
out.push(`<g transform="translate(${W - 40},${60})"><circle r="16" fill="none" stroke="#2a2622"/><path d="M0,-14 L6,8 L0,4 L-6,8 Z" fill="#2a2622"/><text y="-20" text-anchor="middle" font-size="11" font-weight="700">N</text></g>`);
out.push(`<text x="${W / 2}" y="22" text-anchor="middle" font-size="16" font-weight="700" fill="#8a2b2b">DEMO — TYPE C · 2BR + MAID · SUITE 108.5 m² · BALCONY 12.4 m²</text>`);
out.push(`<text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#8a847b">Generated sample plan — not an extracted project. Dimensions in metres.</text>`);
out.push(`</svg>`);

const file = path.join(process.cwd(), "public", "samples", "demo-unit-plan.svg");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out.join("\n"));
console.log("wrote", file, W, H);
