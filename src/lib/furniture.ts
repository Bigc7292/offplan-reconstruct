// Furniture drawn on a plan (or added to dress a room) → simple, recognisable pieces: a bed with pillows, a sofa
// with cushions, a table with chairs, a car in its bay. The footprint (w × d, centre, rotation) is the plan's;
// everything inside it is generic and illustrative.
//
// Local frame: +dy is the piece's back (headboard, sofa back, the wall a unit stands against) and sits at the
// top of the plan when rotation is 0.
import type { Furniture } from "./schema";

export type PartMat =
  | "fabric" | "cushion" | "accent" | "linen" | "throw" | "timber" | "metal" | "joinery" | "counter" | "ceramic"
  | "stone" | "rug" | "black" | "mirror" | "leaf" | "pot" | "carpaint" | "tyre" | "carglass" | "light" | "outdoor" | "teak"
  | "curtain" | "water" | "paint";

export type Part = {
  dx: number; dy: number; w: number; d: number; y0: number; y1: number;
  mat: PartMat;
  bevel?: number;
  /** rotation of the part about its own centre, radians, on top of the piece's */
  rot?: number;
  /** tilt about the part's own x axis, radians (a lounger's back rest) */
  pitch?: number;
  /** a round part (w is the diameter), drawn as a many-sided prism */
  round?: boolean;
};

/** Kinds that are light fittings and hang from the ceiling (hidden with the ceilings in cut-away views). */
export const LIGHT_KINDS = new Set(["pendant", "linear_pendant"]);

export type FurnitureLike = Pick<Furniture, "id" | "center" | "sizeM" | "rotationDeg"> & { kind: string };

export function furnitureHeight(kind: string) {
  return ({
    bed_double: 0.55, bed_single: 0.5, sofa: 0.8, armchair: 0.8, dining: 0.76, desk: 0.75, kitchen_run: 0.92, island: 0.92,
    wardrobe: 2.4, bath: 0.6, wc: 0.4, vanity: 0.85, coffee_table: 0.4, side_table: 0.55, rug: 0.012, media_unit: 0.5,
    ottoman: 0.42, lounger: 0.4, bench: 0.45, planter: 1.2, car: 1.45, shower: 2.1, bbq: 0.92, stool: 0.75, floor_lamp: 1.6,
    mirror: 1.0, dresser: 0.8,
  } as Record<string, number>)[kind] ?? 0.8;
}

/** A deterministic 0..1 value from an id (so the same model always gets the same colours). */
export function hash01(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

export function furnitureParts(f: FurnitureLike, ceilingH = 2.85): Part[] {
  const { w, d, h } = f.sizeM;
  const P: Part[] = [];
  const add = (p: Part) => P.push(p);
  switch (f.kind) {
    case "bed_double":
    case "bed_single": {
      const single = f.kind === "bed_single" || w < 1.3;
      // plans often draw the bedside tables inside the bed's footprint: keep the mattress to a real bed width
      const bw = Math.min(w, single ? 1.1 : 2.0);
      const side = (w - bw) / 2;
      const bd = Math.min(d, 2.2);
      const y = d / 2 - bd / 2; // push the bed against the head wall
      add({ dx: 0, dy: y + bd / 2 - 0.05, w: bw + 0.12, d: 0.1, y0: 0.05, y1: 1.15, mat: "fabric", bevel: 0.03 }); // upholstered headboard
      add({ dx: 0, dy: y - 0.05, w: bw, d: bd - 0.1, y0: 0.08, y1: 0.3, mat: "fabric", bevel: 0.02 }); // base
      add({ dx: 0, dy: y - 0.05, w: bw - 0.08, d: bd - 0.18, y0: 0, y1: 0.1, mat: "timber" }); // shadow gap plinth
      add({ dx: 0, dy: y - 0.07, w: bw - 0.04, d: bd - 0.16, y0: 0.3, y1: 0.52, mat: "linen", bevel: 0.05 }); // mattress + sheet
      add({ dx: 0, dy: y - bd / 2 + (bd * 0.62) / 2 + 0.02, w: bw + 0.02, d: bd * 0.62, y0: 0.5, y1: 0.57, mat: "linen", bevel: 0.035 }); // duvet
      add({ dx: 0, dy: y - bd / 2 + 0.3, w: bw + 0.04, d: 0.42, y0: 0.55, y1: 0.59, mat: "throw", bevel: 0.02 }); // throw at the foot
      const n = single ? 1 : 2;
      const pw = (bw - 0.16) / n - 0.04;
      for (let i = 0; i < n; i++) {
        const px = -bw / 2 + 0.1 + pw / 2 + i * (pw + 0.06);
        add({ dx: px, dy: y + bd / 2 - 0.34, w: pw, d: 0.36, y0: 0.52, y1: 0.68, mat: "linen", bevel: 0.07 });
        add({ dx: px, dy: y + bd / 2 - 0.52, w: pw * 0.85, d: 0.12, y0: 0.52, y1: 0.78, mat: "cushion", bevel: 0.05 });
      }
      if (!single) add({ dx: 0, dy: y + bd / 2 - 0.62, w: 0.5, d: 0.12, y0: 0.55, y1: 0.8, mat: "accent", bevel: 0.05 });
      if (side >= 0.35 && !single) {
        for (const sx of [-1, 1]) {
          const cx = sx * (bw / 2 + side / 2);
          add({ dx: cx, dy: y + bd / 2 - 0.3, w: Math.min(0.5, side - 0.05), d: 0.42, y0: 0.0, y1: 0.5, mat: "joinery", bevel: 0.01 });
          add({ dx: cx, dy: y + bd / 2 - 0.3, w: 0.16, d: 0.16, y0: 0.5, y1: 0.8, mat: "linen", bevel: 0.03, round: true }); // lamp
        }
      }
      return P;
    }
    case "sofa":
    case "armchair": {
      const arm = Math.min(0.2, w * 0.18);
      const back = Math.min(0.22, d * 0.3);
      const sh = 0.42, top = Math.max(0.72, Math.min(h, 0.85));
      for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add({ dx: lx * (w / 2 - 0.06), dy: ly * (d / 2 - 0.06), w: 0.04, d: 0.04, y0: 0, y1: 0.08, mat: "timber" });
      add({ dx: 0, dy: 0, w, d, y0: 0.08, y1: 0.3, mat: "fabric", bevel: 0.03 }); // frame
      add({ dx: 0, dy: d / 2 - back / 2, w, d: back, y0: 0.3, y1: top, mat: "fabric", bevel: 0.05 }); // back
      for (const sx of [-1, 1]) add({ dx: sx * (w / 2 - arm / 2), dy: -back / 2, w: arm, d: d - back, y0: 0.3, y1: 0.6, mat: "fabric", bevel: 0.05 });
      const seatW = w - 2 * arm;
      const n = Math.max(1, Math.round(seatW / 0.9));
      const cw = seatW / n;
      for (let i = 0; i < n; i++) {
        const cx = -seatW / 2 + cw * (i + 0.5);
        add({ dx: cx, dy: -back / 2, w: cw - 0.02, d: d - back - 0.02, y0: 0.3, y1: sh + 0.06, mat: "fabric", bevel: 0.06 }); // seat cushion
        add({ dx: cx, dy: d / 2 - back - 0.08, w: cw - 0.04, d: 0.16, y0: sh + 0.04, y1: top - 0.04, mat: "fabric", bevel: 0.07 }); // back cushion
      }
      if (f.kind === "sofa" && seatW > 1.2) {
        add({ dx: -seatW / 2 + 0.3, dy: d / 2 - back - 0.2, w: 0.42, d: 0.12, y0: sh + 0.06, y1: sh + 0.44, mat: "accent", bevel: 0.06 });
        add({ dx: seatW / 2 - 0.3, dy: d / 2 - back - 0.2, w: 0.42, d: 0.12, y0: sh + 0.06, y1: sh + 0.44, mat: "cushion", bevel: 0.06 });
      }
      return P;
    }
    case "dining": {
      const long = Math.max(w, d), short = Math.min(w, d);
      const th = 0.75;
      if (long - short < 0.25) {
        // a round table: pedestal, round top, chairs all round
        add({ dx: 0, dy: 0, w: long, d: long, y0: th - 0.04, y1: th, mat: "joinery", round: true });
        add({ dx: 0, dy: 0, w: 0.16, d: 0.16, y0: 0.05, y1: th - 0.04, mat: "timber", round: true });
        add({ dx: 0, dy: 0, w: 0.55, d: 0.55, y0: 0, y1: 0.05, mat: "timber", round: true });
        const n = Math.max(3, Math.min(8, Math.round((Math.PI * (long + 0.5)) / 0.7)));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const r = long / 2 + 0.14;
          P.push(...chair(Math.cos(a) * r, Math.sin(a) * r, a - Math.PI / 2));
        }
        return P;
      }
      const alongX = w >= d;
      add({ dx: 0, dy: 0, w, d, y0: th - 0.04, y1: th, mat: "joinery", bevel: 0.008 });
      for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add({ dx: lx * (w / 2 - 0.1), dy: ly * (d / 2 - 0.1), w: 0.06, d: 0.06, y0: 0, y1: th - 0.04, mat: "timber" });
      if (short >= 0.7 && long >= 0.9) {
        const n = Math.max(1, Math.floor((long - 0.1) / 0.62));
        const pitch = long / n;
        for (let i = 0; i < n; i++) {
          const t = -long / 2 + pitch * (i + 0.5);
          for (const sd of [-1, 1]) {
            const off = short / 2 + 0.12;
            const [cx, cy] = alongX ? [t, sd * off] : [sd * off, t];
            const rot = alongX ? (sd > 0 ? 0 : Math.PI) : (sd > 0 ? -Math.PI / 2 : Math.PI / 2);
            P.push(...chair(cx, cy, rot));
          }
        }
        if (long / short > 1.6) {
          for (const sd of [-1, 1]) {
            const off = long / 2 + 0.14;
            const [cx, cy] = alongX ? [sd * off, 0] : [0, sd * off];
            const rot = alongX ? (sd > 0 ? -Math.PI / 2 : Math.PI / 2) : (sd > 0 ? 0 : Math.PI);
            P.push(...chair(cx, cy, rot));
          }
        }
      }
      return P;
    }
    case "desk":
      add({ dx: 0, dy: 0, w, d, y0: h - 0.04, y1: h, mat: "joinery", bevel: 0.006 });
      for (const sx of [-1, 1]) add({ dx: sx * (w / 2 - 0.02), dy: 0, w: 0.04, d: d - 0.02, y0: 0, y1: h - 0.04, mat: "joinery" });
      P.push(...chair(0, -d / 2 - 0.1, Math.PI));
      return P;
    case "kitchen_run":
    case "island":
    case "bbq": {
      const ch = Math.max(0.86, Math.min(h, 0.95));
      const island = f.kind === "island";
      // a long run gets a bank of tall units (ovens, fridge) at one end
      const tall = f.kind === "kitchen_run" && w >= 3.4 ? Math.min(1.8, w * 0.3) : 0;
      const lw = w - tall;
      const lx = -tall / 2; // centre of the low part
      if (tall) {
        const tx = w / 2 - tall / 2;
        add({ dx: tx, dy: 0.01, w: tall, d: d - 0.02, y0: 0, y1: Math.min(2.4, ceilingH - 0.15), mat: "joinery" });
        const n = Math.max(1, Math.round(tall / 0.6));
        for (let i = 0; i < n; i++) {
          const fx = tx - tall / 2 + (tall / n) * (i + 0.5);
          add({ dx: fx, dy: -d / 2 + 0.005, w: tall / n - 0.004, d: 0.02, y0: 0.1, y1: Math.min(2.38, ceilingH - 0.17), mat: "joinery", bevel: 0.002 });
          if (i === n - 1 && n > 1) add({ dx: fx, dy: -d / 2 - 0.004, w: tall / n - 0.1, d: 0.01, y0: 0.9, y1: 1.5, mat: "black" }); // built-in oven
        }
      }
      add({ dx: lx, dy: 0.03, w: lw - 0.02, d: d - 0.08, y0: 0, y1: 0.1, mat: "timber" }); // recessed plinth
      add({ dx: lx, dy: 0.01, w: lw, d: d - 0.03, y0: 0.1, y1: ch - 0.04, mat: f.kind === "bbq" ? "stone" : "joinery" }); // carcass
      const n = Math.max(1, Math.round(lw / 0.6));
      const fw = lw / n;
      for (let i = 0; i < n; i++) {
        for (const sd of island ? [-1, 1] : [-1]) {
          add({ dx: lx - lw / 2 + fw * (i + 0.5), dy: sd * (d / 2 - 0.01), w: fw - 0.004, d: 0.02, y0: 0.11, y1: ch - 0.05, mat: f.kind === "bbq" ? "stone" : "joinery", bevel: 0.002 });
          add({ dx: lx - lw / 2 + fw * (i + 0.5), dy: sd * (d / 2 + 0.005), w: Math.min(0.3, fw * 0.5), d: 0.01, y0: ch - 0.12, y1: ch - 0.1, mat: "metal" }); // handle rail
        }
      }
      add({ dx: lx, dy: 0, w: lw + 0.02, d: d + 0.02, y0: ch - 0.04, y1: ch, mat: "counter", bevel: 0.004 });
      if (island) {
        // waterfall ends in the worktop stone
        for (const sx of [-1, 1]) add({ dx: sx * (w / 2 + 0.01), dy: 0, w: 0.04, d: d + 0.02, y0: 0, y1: ch, mat: "counter", bevel: 0.004 });
      }
      if (f.kind === "bbq") {
        add({ dx: lx - lw * 0.15, dy: 0, w: Math.min(0.9, lw * 0.45), d: d * 0.7, y0: ch, y1: ch + 0.02, mat: "black" }); // grill
        add({ dx: lx - lw * 0.15, dy: d * 0.1, w: Math.min(0.9, lw * 0.45), d: d * 0.5, y0: ch + 0.02, y1: ch + 0.22, mat: "metal", bevel: 0.05 }); // hood
      } else if (lw >= 1.2) {
        // sink with a tap, and a hob, set into the worktop
        const sinkX = lx - lw / 4, hobX = lx + lw / 4;
        add({ dx: sinkX, dy: -0.02, w: 0.6, d: Math.min(0.42, d - 0.18), y0: ch - 0.005, y1: ch + 0.002, mat: "metal" });
        add({ dx: sinkX, dy: d / 2 - 0.08, w: 0.04, d: 0.04, y0: ch, y1: ch + 0.32, mat: "metal", round: true });
        add({ dx: sinkX, dy: d / 2 - 0.16, w: 0.03, d: 0.18, y0: ch + 0.28, y1: ch + 0.31, mat: "metal" });
        if (!island || lw >= 2.4) add({ dx: hobX, dy: -0.02, w: 0.72, d: Math.min(0.5, d - 0.12), y0: ch, y1: ch + 0.006, mat: "black" });
      }
      return P;
    }
    case "wardrobe": {
      const wh = Math.max(2.2, Math.min(h, 2.6, ceilingH - 0.05));
      add({ dx: 0, dy: 0.01, w, d: d - 0.02, y0: 0, y1: wh, mat: "joinery" });
      const n = Math.max(1, Math.round(w / 0.55));
      const fw = w / n;
      for (let i = 0; i < n; i++) {
        add({ dx: -w / 2 + fw * (i + 0.5), dy: -d / 2 + 0.005, w: fw - 0.004, d: 0.02, y0: 0.02, y1: wh - 0.02, mat: "joinery", bevel: 0.002 });
        const hx = -w / 2 + fw * (i + 0.5) + (i % 2 ? -1 : 1) * (fw / 2 - 0.06);
        add({ dx: hx, dy: -d / 2 - 0.01, w: 0.015, d: 0.015, y0: 0.9, y1: 1.4, mat: "metal" });
      }
      return P;
    }
    case "nightstand":
      add({ dx: 0, dy: 0.01, w, d: d - 0.02, y0: 0.12, y1: 0.52, mat: "joinery", bevel: 0.004 });
      add({ dx: 0, dy: -d / 2 + 0.005, w: w - 0.03, d: 0.02, y0: 0.3, y1: 0.5, mat: "joinery", bevel: 0.002 });
      add({ dx: 0, dy: 0, w: w * 0.5, d: d * 0.5, y0: 0, y1: 0.12, mat: "metal" });
      add({ dx: w * 0.12, dy: d * 0.1, w: 0.12, d: 0.12, y0: 0.52, y1: 0.78, mat: "metal", round: true }); // lamp base
      add({ dx: w * 0.12, dy: d * 0.1, w: 0.3, d: 0.3, y0: 0.72, y1: 0.92, mat: "light", round: true }); // lamp shade
      return P;
    case "dresser": {
      add({ dx: 0, dy: 0.01, w, d: d - 0.02, y0: 0.08, y1: h, mat: "joinery", bevel: 0.004 });
      const rows = 3;
      for (let r = 0; r < rows; r++) {
        const y0 = 0.1 + ((h - 0.12) / rows) * r;
        add({ dx: 0, dy: -d / 2 + 0.005, w: w - 0.03, d: 0.02, y0: y0 + 0.01, y1: y0 + (h - 0.12) / rows - 0.01, mat: "joinery", bevel: 0.002 });
      }
      add({ dx: 0, dy: 0, w: w + 0.01, d: d + 0.01, y0: h, y1: h + 0.02, mat: "counter" });
      return P;
    }
    case "bath": {
      const bh = 0.55, rim = 0.08;
      add({ dx: 0, dy: 0, w, d, y0: 0, y1: 0.1, mat: "ceramic", bevel: 0.01 });
      add({ dx: 0, dy: -d / 2 + rim / 2, w, d: rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: 0, dy: d / 2 - rim / 2, w, d: rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: -w / 2 + rim / 2, dy: 0, w: rim, d: d - 2 * rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: w / 2 - rim / 2, dy: 0, w: rim, d: d - 2 * rim, y0: 0.1, y1: bh, mat: "ceramic", bevel: 0.02 });
      add({ dx: 0, dy: 0, w: w - 2 * rim, d: d - 2 * rim, y0: 0.1, y1: bh - 0.12, mat: "water" });
      add({ dx: w / 2 - rim - 0.05, dy: 0, w: 0.04, d: 0.04, y0: bh, y1: bh + 0.18, mat: "metal" }); // filler
      return P;
    }
    case "shower": {
      add({ dx: 0, dy: 0, w, d, y0: 0, y1: 0.03, mat: "ceramic" }); // tray
      add({ dx: 0, dy: -d / 2 + 0.01, w: w * 0.6, d: 0.012, y0: 0.03, y1: 2.0, mat: "carglass" }); // glass screen
      add({ dx: 0, dy: d / 2 - 0.15, w: 0.25, d: 0.25, y0: 2.05, y1: 2.07, mat: "metal", round: true }); // rain head
      return P;
    }
    case "wc": {
      const cw = Math.min(w, 0.4), cd = Math.min(d, 0.58);
      add({ dx: 0, dy: d / 2 - 0.09, w: cw, d: 0.16, y0: 0.35, y1: 0.8, mat: "ceramic", bevel: 0.02 }); // cistern
      add({ dx: 0, dy: d / 2 - cd / 2 - 0.05, w: cw * 0.9, d: cd - 0.12, y0: 0.0, y1: 0.4, mat: "ceramic", bevel: 0.06 }); // bowl
      return P;
    }
    case "vanity": {
      add({ dx: 0, dy: 0.02, w, d: d - 0.04, y0: 0.3, y1: 0.8, mat: "joinery", bevel: 0.004 }); // floating unit
      add({ dx: 0, dy: 0, w: w + 0.01, d, y0: 0.8, y1: 0.84, mat: "counter", bevel: 0.004 });
      const n = w >= 1.3 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const cx = n === 1 ? 0 : (i === 0 ? -w / 4 : w / 4);
        add({ dx: cx, dy: -0.03, w: Math.min(0.5, w / n - 0.1), d: Math.min(0.36, d - 0.1), y0: 0.84, y1: 0.97, mat: "ceramic", bevel: 0.04 }); // basin
        add({ dx: cx, dy: d / 2 - 0.06, w: 0.03, d: 0.12, y0: 0.84, y1: 1.08, mat: "metal" }); // tap
      }
      add({ dx: 0, dy: d / 2 + 0.01, w: Math.max(0.5, w - 0.1), d: 0.02, y0: 1.1, y1: Math.min(2.1, ceilingH - 0.3), mat: "mirror" }); // mirror on the wall behind
      return P;
    }
    case "coffee_table": {
      const round = Math.abs(w - d) < 0.2;
      add({ dx: 0, dy: 0, w, d, y0: 0.34, y1: 0.4, mat: "stone", bevel: round ? undefined : 0.01, round });
      add({ dx: 0, dy: 0, w: w * 0.7, d: d * 0.7, y0: 0, y1: 0.34, mat: round ? "stone" : "timber", bevel: round ? undefined : 0.01, round });
      add({ dx: w * 0.18, dy: 0.05, w: 0.28, d: 0.2, y0: 0.4, y1: 0.46, mat: "accent", bevel: 0.01 }); // books
      add({ dx: -w * 0.2, dy: -0.04, w: 0.14, d: 0.14, y0: 0.4, y1: 0.58, mat: "pot", round: true }); // vase
      return P;
    }
    case "side_table":
      add({ dx: 0, dy: 0, w: Math.min(w, d), d: Math.min(w, d), y0: 0.5, y1: 0.54, mat: "stone", round: true });
      add({ dx: 0, dy: 0, w: 0.08, d: 0.08, y0: 0.02, y1: 0.5, mat: "metal", round: true });
      add({ dx: 0, dy: 0, w: Math.min(w, d) * 0.7, d: Math.min(w, d) * 0.7, y0: 0, y1: 0.02, mat: "metal", round: true });
      return P;
    case "rug":
      add({ dx: 0, dy: 0, w, d, y0: 0, y1: 0.012, mat: "rug", bevel: 0.004 });
      return P;
    case "media_unit": {
      add({ dx: 0, dy: 0, w, d, y0: 0.18, y1: 0.55, mat: "joinery", bevel: 0.004 });
      const tvW = Math.min(1.65, w * 0.75);
      add({ dx: 0, dy: d / 2 - 0.02, w: tvW, d: 0.04, y0: 0.95, y1: 0.95 + tvW * 0.5625, mat: "black", bevel: 0.004 }); // screen on the wall
      return P;
    }
    case "ottoman":
      add({ dx: 0, dy: 0, w, d, y0: 0.02, y1: Math.min(h, 0.45), mat: "accent", bevel: 0.06 });
      return P;
    case "bench":
      add({ dx: 0, dy: 0, w, d, y0: 0.32, y1: 0.45, mat: "fabric", bevel: 0.04 });
      for (const sx of [-1, 1]) add({ dx: sx * (w / 2 - 0.05), dy: 0, w: 0.04, d: d - 0.06, y0: 0, y1: 0.32, mat: "metal" });
      return P;
    case "lounger": {
      // sun lounger: frame, cushion, raised back rest at the +dy end
      const back = Math.min(0.75, d * 0.38);
      add({ dx: 0, dy: -back / 2, w, d: d - back, y0: 0.2, y1: 0.3, mat: "teak", bevel: 0.015 });
      add({ dx: 0, dy: -back / 2, w: w - 0.04, d: d - back - 0.04, y0: 0.3, y1: 0.38, mat: "outdoor", bevel: 0.03 });
      const tilt = 0.75;
      add({ dx: 0, dy: d / 2 - back / 2 - 0.08, w: w - 0.04, d: back, y0: 0.3 + Math.sin(tilt) * back / 2, y1: 0.38 + Math.sin(tilt) * back / 2, mat: "outdoor", bevel: 0.03, pitch: -tilt });
      for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add({ dx: lx * (w / 2 - 0.05), dy: ly * (d / 2 - 0.1), w: 0.05, d: 0.05, y0: 0, y1: 0.2, mat: "teak" });
      return P;
    }
    case "planter": {
      const r = Math.min(w, d);
      add({ dx: 0, dy: 0, w: r * 0.7, d: r * 0.7, y0: 0, y1: 0.45, mat: "pot", round: true });
      add({ dx: 0, dy: 0, w: r, d: r, y0: 0.45, y1: Math.max(0.9, h * 0.65), mat: "leaf", round: true });
      add({ dx: 0.05, dy: -0.04, w: r * 0.72, d: r * 0.72, y0: Math.max(0.9, h * 0.65), y1: Math.max(1.2, h), mat: "leaf", round: true });
      return P;
    }
    case "stool":
      add({ dx: 0, dy: 0, w: 0.38, d: 0.38, y0: h - 0.06, y1: h, mat: "fabric", round: true });
      add({ dx: 0, dy: 0, w: 0.05, d: 0.05, y0: 0.02, y1: h - 0.06, mat: "metal", round: true });
      add({ dx: 0, dy: 0, w: 0.34, d: 0.34, y0: 0, y1: 0.02, mat: "metal", round: true });
      add({ dx: 0, dy: 0, w: 0.34, d: 0.34, y0: 0.28, y1: 0.3, mat: "metal", round: true });
      return P;
    case "floor_lamp":
      add({ dx: 0, dy: 0, w: 0.28, d: 0.28, y0: 0, y1: 0.02, mat: "metal", round: true });
      add({ dx: 0, dy: 0, w: 0.025, d: 0.025, y0: 0.02, y1: 1.3, mat: "metal", round: true });
      add({ dx: 0, dy: 0, w: 0.42, d: 0.42, y0: 1.3, y1: 1.62, mat: "light", round: true });
      return P;
    case "mirror":
      add({ dx: 0, dy: 0, w, d: 0.02, y0: 0.9, y1: Math.min(2.1, ceilingH - 0.3), mat: "mirror" });
      return P;
    case "car": {
      // an illustrative car in its bay (the plan's car symbol): body, glasshouse, wheels
      const L = Math.min(Math.max(w, d), 4.9), W = Math.min(Math.min(w, d), 1.95);
      const alongY = d >= w;
      const box = (x: number, y: number, bw: number, bd: number, y0: number, y1: number, mat: PartMat, bevel?: number) =>
        add(alongY ? { dx: x, dy: y, w: bw, d: bd, y0, y1, mat, bevel } : { dx: y, dy: x, w: bd, d: bw, y0, y1, mat, bevel });
      box(0, 0, W, L, 0.3, 0.92, "carpaint", 0.14);
      box(0, -0.25, W - 0.22, L * 0.48, 0.9, 1.4, "carglass", 0.16);
      box(0, -0.25, W - 0.34, L * 0.44, 1.38, 1.44, "carpaint", 0.04);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(sx * (W / 2 - 0.14), sy * (L / 2 - 0.78), 0.24, 0.68, 0, 0.66, "tyre", 0.12);
      box(0, L / 2 - 0.04, W - 0.5, 0.06, 0.62, 0.72, "light"); // lamps
      return P;
    }
    case "pendant":
      // a drum pendant on a drop that keeps its underside above head height (2.1 m or more)
      {
        const bottom = Math.max(2.1, ceilingH - 0.85);
        const dia = Math.min(w, 0.45);
        add({ dx: 0, dy: 0, w: 0.012, d: 0.012, y0: bottom + 0.18, y1: ceilingH, mat: "metal", round: true });
        add({ dx: 0, dy: 0, w: dia, d: dia, y0: bottom, y1: bottom + 0.18, mat: "light", round: true });
      }
      return P;
    case "linear_pendant":
      {
        const bottom = Math.max(2.1, ceilingH - 0.8);
        for (const sx of [-1, 1]) add({ dx: sx * (w / 2 - 0.1), dy: 0, w: 0.012, d: 0.012, y0: bottom + 0.05, y1: ceilingH, mat: "metal" });
        add({ dx: 0, dy: 0, w, d: 0.1, y0: bottom + 0.012, y1: bottom + 0.05, mat: "metal" });
        add({ dx: 0, dy: 0, w: w - 0.04, d: 0.06, y0: bottom, y1: bottom + 0.012, mat: "light" });
      }
      return P;
    case "curtain": {
      // a sheer curtain stacked at the side of a window, on a ceiling track
      const folds = Math.max(2, Math.round(w / 0.12));
      for (let i = 0; i < folds; i++) {
        add({ dx: -w / 2 + (w / folds) * (i + 0.5), dy: (i % 2 ? 0.03 : -0.03), w: w / folds + 0.02, d: 0.035, y0: 0.02, y1: ceilingH - 0.06, mat: "curtain" });
      }
      add({ dx: 0, dy: 0, w: w + 0.1, d: 0.05, y0: ceilingH - 0.06, y1: ceilingH - 0.02, mat: "metal" });
      return P;
    }
    default:
      add({ dx: 0, dy: 0, w, d, y0: 0, y1: h, mat: "joinery", bevel: 0.005 });
      return P;
  }
}

/** A dining chair facing the table: rot 0 = the chair sits on +dy of its spot and faces -dy. */
function chair(cx: number, cy: number, rot: number): Part[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  const at = (x: number, y: number) => ({ dx: cx + x * c - y * s, dy: cy + x * s + y * c });
  return [
    { ...at(0, 0), w: 0.46, d: 0.46, y0: 0.42, y1: 0.48, mat: "fabric", bevel: 0.02, rot },
    { ...at(0, 0.2), w: 0.44, d: 0.05, y0: 0.48, y1: 0.88, mat: "fabric", bevel: 0.02, rot },
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([lx, ly]) => ({ ...at(lx * 0.19, ly * 0.19), w: 0.03, d: 0.03, y0: 0, y1: 0.42, mat: "timber" as const, rot })),
  ];
}

/** Regular n-gon in plan space (round parts, columns, trees). */
export function circle(cx: number, cy: number, r: number, n = 16) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: Math.round((cx + Math.cos(a) * r) * 1000) / 1000, y: Math.round((cy + Math.sin(a) * r) * 1000) / 1000 };
  });
}
