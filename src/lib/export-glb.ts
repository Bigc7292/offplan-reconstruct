// Scene graph → binary glTF 2.0 (.glb), written directly (no DOM / FileReader needed on the server).
// Uses the same triangle builder as the viewer, one mesh per material group.
import type { PropertySceneGraph } from "./schema";
import { buildGroups } from "@/scene/geometry";

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

export function exportGlb(g: PropertySceneGraph, opts: { includeInferred?: boolean; includeCeilings?: boolean } = {}): Buffer {
  const includeInferred = opts.includeInferred ?? true;
  const includeCeilings = opts.includeCeilings ?? true;
  const groups = buildGroups(g).filter((grp) => (includeInferred || !grp.inferred) && (includeCeilings || grp.layer !== "ceiling"));

  const matIndex = new Map<string, number>();
  const materials = g.materials.map((m, i) => {
    matIndex.set(m.id, i);
    const [r, gg, b] = hexToLinear(m.color);
    return {
      name: m.name,
      pbrMetallicRoughness: { baseColorFactor: [r, gg, b, m.opacity], metallicFactor: m.metalness, roughnessFactor: m.roughness },
      ...(m.opacity < 1 ? { alphaMode: "BLEND", doubleSided: true } : {}),
      ...(m.emissive ? { emissiveFactor: hexToLinear(m.emissive) } : {}),
      extras: { inferred: m.inferred },
    };
  });

  const chunks: Buffer[] = [];
  let byteOffset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const meshes: object[] = [];
  const nodes: object[] = [];

  const addView = (buf: Buffer, target: number) => {
    const pad = (4 - (buf.length % 4)) % 4;
    const padded = pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
    chunks.push(padded);
    byteOffset += padded.length;
    return bufferViews.length - 1;
  };

  for (const grp of groups) {
    const { positions, normals, uvs, indices } = grp.buffers;
    if (!indices.length) continue;
    const pos = Buffer.from(new Float32Array(positions).buffer);
    const nor = Buffer.from(new Float32Array(normals).buffer);
    const uv = Buffer.from(new Float32Array(uvs).buffer);
    const idx = Buffer.from(new Uint32Array(indices).buffer);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3)
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
    const vPos = addView(pos, 34962), vNor = addView(nor, 34962), vUv = addView(uv, 34962), vIdx = addView(idx, 34963);
    const count = positions.length / 3;
    accessors.push({ bufferView: vPos, componentType: 5126, count, type: "VEC3", min, max });
    const aPos = accessors.length - 1;
    accessors.push({ bufferView: vNor, componentType: 5126, count, type: "VEC3" });
    const aNor = accessors.length - 1;
    accessors.push({ bufferView: vUv, componentType: 5126, count, type: "VEC2" });
    const aUv = accessors.length - 1;
    accessors.push({ bufferView: vIdx, componentType: 5125, count: indices.length, type: "SCALAR" });
    const aIdx = accessors.length - 1;
    meshes.push({
      name: grp.key,
      primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor, TEXCOORD_0: aUv }, indices: aIdx, material: matIndex.get(grp.materialId) ?? 0 }],
    });
    nodes.push({ name: `${grp.levelId}/${grp.materialId}/${grp.layer}${grp.inferred ? "/inferred" : ""}`, mesh: meshes.length - 1, extras: { levelId: grp.levelId, layer: grp.layer, inferred: grp.inferred } });
  }

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator: "OffPlan Reconstruct", copyright: g.disclaimer },
    scene: 0,
    scenes: [{ name: g.title, nodes: nodes.map((_, i) => i), extras: { jobId: g.jobId, dossierHash: g.dossierHash, demo: g.demo, disclaimer: g.disclaimer } }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jpad = (4 - (jsonBuf.length % 4)) % 4;
  if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4); // JSON
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4); // BIN
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
