"use client";
// Procedural surface detail for the viewer: tile joints and veining for stone, planks for wood,
// weave for wallcoverings. Only the *pattern* is procedural; the colour always stays the documented
// (or render-sampled) albedo, because the texture is a near-white detail map the colour multiplies.
// Geometry UVs are in metres, so `metres` is the real size one texture repeat covers.
import * as THREE from "three";

type Pattern = { kind: "stone" | "wood" | "chevron" | "weave" | "carpet" | "plaster" | "paving"; metres: number };

export function patternFor(name: string, surface: "floor" | "wall" | "other"): Pattern | null {
  const n = name.toLowerCase();
  if (/grass|turf|lawn|water|pool|glass|glazing|default|proxy|frame|slab/.test(n)) return null;
  if (/chevron|herringbone/.test(n)) return { kind: "chevron", metres: 1.2 };
  if (/wood|oak|walnut|teak|parquet|timber|veneer|plank/.test(n)) return surface === "floor" ? { kind: "wood", metres: 2.4 } : { kind: "weave", metres: 1.2 };
  if (/carpet|rug/.test(n)) return { kind: "carpet", metres: 1 };
  if (/paver|paving|brick/.test(n)) return { kind: "paving", metres: 1.2 };
  if (/grasscloth|wallcovering|textured/.test(n)) return { kind: "weave", metres: 0.6 };
  if (/marble|stone|tile|porcelain|travertine|limestone|terrazzo|concrete|cement/.test(n)) return surface === "floor" ? { kind: "stone", metres: 2.4 } : { kind: "plaster", metres: 2 };
  if (surface === "wall") return { kind: "plaster", metres: 2 };
  return null;
}

// deterministic noise so the same model always looks the same
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const cache = new Map<string, THREE.Texture>();

export function detailTexture(p: Pattern): THREE.Texture {
  const key = `${p.kind}:${p.metres}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const r = rng(p.kind.length * 7919 + Math.round(p.metres * 100));
  g.fillStyle = "#f6f6f6";
  g.fillRect(0, 0, S, S);
  const pxPerM = S / p.metres;

  if (p.kind === "stone") {
    // large-format slabs 1.2 × 0.6 m with soft veining and 2 mm joints
    const tw = 1.2 * pxPerM, th = 0.6 * pxPerM;
    for (let y = 0; y < S; y += th) for (let x = 0; x < S; x += tw) {
      const v = 238 + Math.floor(r() * 14);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, y, tw, th);
    }
    g.globalAlpha = 0.18;
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = r() > 0.5 ? "#b8b8b8" : "#d0d0d0";
      g.lineWidth = 0.6 + r() * 1.6;
      g.beginPath();
      let x = r() * S, y = r() * S;
      g.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += (r() - 0.3) * 90; y += (r() - 0.5) * 60; g.lineTo(x, y); }
      g.stroke();
    }
    g.globalAlpha = 1;
    g.strokeStyle = "rgba(120,120,120,0.55)";
    g.lineWidth = 1.2;
    for (let y = 0; y <= S; y += th) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
    for (let y = 0; y < S; y += th) for (let x = 0; x <= S; x += tw) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + th); g.stroke(); }
  } else if (p.kind === "wood") {
    // 0.19 m planks, staggered ends, grain streaks
    const pw = 0.19 * pxPerM;
    for (let x = 0; x < S; x += pw) {
      let y = -r() * S;
      while (y < S) {
        const len = (0.9 + r() * 1.2) * pxPerM;
        const v = 225 + Math.floor(r() * 28);
        g.fillStyle = `rgb(${v},${v - 2},${v - 5})`;
        g.fillRect(x, y, pw, len);
        g.globalAlpha = 0.12;
        for (let k = 0; k < 7; k++) {
          g.strokeStyle = "#8a7a6a";
          g.lineWidth = 0.5 + r();
          const gx = x + r() * pw;
          g.beginPath(); g.moveTo(gx, y); g.bezierCurveTo(gx + 3, y + len / 3, gx - 3, y + (2 * len) / 3, gx + (r() - 0.5) * 4, y + len); g.stroke();
        }
        g.globalAlpha = 1;
        g.strokeStyle = "rgba(90,70,50,0.45)";
        g.lineWidth = 1;
        g.strokeRect(x, y, pw, len);
        y += len;
      }
    }
  } else if (p.kind === "chevron") {
    const pw = 0.1 * pxPerM, pl = 0.6 * pxPerM;
    g.save();
    for (let col = -1; col < S / pl + 1; col++) {
      for (let row = -2; row < S / pw + 2; row++) {
        const v = 222 + Math.floor(r() * 30);
        g.fillStyle = `rgb(${v},${v - 3},${v - 7})`;
        g.save();
        const cx = col * pl * 0.72, cy = row * pw * 1.42;
        g.translate(cx, cy);
        g.rotate((col % 2 ? 1 : -1) * Math.PI / 4);
        g.fillRect(0, 0, pl * 0.5, pw);
        g.strokeStyle = "rgba(90,70,50,0.4)";
        g.strokeRect(0, 0, pl * 0.5, pw);
        g.restore();
      }
    }
    g.restore();
  } else if (p.kind === "weave") {
    for (let x = 0; x < S; x += 2) {
      const v = 236 + Math.floor(r() * 18);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, 0, 2, S);
    }
    g.globalAlpha = 0.25;
    for (let y = 0; y < S; y += 3) { g.fillStyle = r() > 0.5 ? "#fff" : "#e6e6e6"; g.fillRect(0, y, S, 1); }
    g.globalAlpha = 1;
  } else if (p.kind === "carpet") {
    const img = g.getImageData(0, 0, S, S);
    for (let i = 0; i < img.data.length; i += 4) { const v = 232 + Math.floor(r() * 22); img.data[i] = img.data[i + 1] = img.data[i + 2] = v; }
    g.putImageData(img, 0, 0);
  } else if (p.kind === "paving") {
    const tw = 0.3 * pxPerM, th = 0.15 * pxPerM;
    for (let y = 0, row = 0; y < S; y += th, row++) for (let x = row % 2 ? -tw / 2 : 0; x < S; x += tw) {
      const v = 226 + Math.floor(r() * 26);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, y, tw, th);
      g.strokeStyle = "rgba(110,110,110,0.5)";
      g.strokeRect(x, y, tw, th);
    }
  } else if (p.kind === "plaster") {
    const img = g.getImageData(0, 0, S, S);
    for (let i = 0; i < img.data.length; i += 4) { const v = 243 + Math.floor(r() * 9); img.data[i] = img.data[i + 1] = img.data[i + 2] = v; }
    g.putImageData(img, 0, 0);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / p.metres, 1 / p.metres);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}
