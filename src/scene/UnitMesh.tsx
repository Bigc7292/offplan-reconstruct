"use client";
// Renders the scene graph as a handful of merged meshes (one per level × material × layer).
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { PropertySceneGraph, ScenePiece } from "@/lib/schema";
import { buildGroups, type MeshGroup } from "./geometry";
import { detailTexture, patternFor } from "./textures";

export type PickInfo = { piece: ScenePiece; pieceIndex: number; point: THREE.Vector3 };

function toGeometry(g: MeshGroup) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(g.buffers.positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(g.buffers.normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.buffers.uvs, 2));
  geo.setIndex(g.buffers.indices);
  geo.computeBoundingSphere();
  return geo;
}

export function useSceneMaterials(scene: PropertySceneGraph, jobId: string) {
  return useMemo(() => {
    const loader = new THREE.TextureLoader();
    const map = new Map<string, { base: THREE.MeshStandardMaterial; inferred: THREE.MeshStandardMaterial }>();
    // which surface each material is used on decides its detail pattern (stone floor vs stone wall)
    const usedOn = new Map<string, Set<string>>();
    for (const p of scene.pieces) usedOn.set(p.materialId, (usedOn.get(p.materialId) ?? new Set()).add(p.elementKind));
    for (const m of scene.materials) {
      const glass = m.opacity < 1;
      const base = new THREE.MeshStandardMaterial({
        color: new THREE.Color(m.color),
        roughness: m.roughness,
        metalness: m.metalness,
        transparent: glass,
        opacity: m.opacity,
        depthWrite: !glass,
        side: glass ? THREE.DoubleSide : THREE.FrontSide,
        envMapIntensity: glass ? 1.4 : 0.9,
      });
      const kinds = usedOn.get(m.id) ?? new Set<string>();
      const pattern = patternFor(m.name, kinds.has("floor") ? "floor" : kinds.has("wall") ? "wall" : "other");
      if (pattern && !m.textureAssetPath) base.map = detailTexture(pattern);
      if (m.textureAssetPath) {
        const url = m.textureAssetPath.startsWith("/") ? m.textureAssetPath : `/api/jobs/${jobId}/files/${m.textureAssetPath}`;
        const tex = loader.load(url);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        base.map = tex;
      }
      // inferred geometry: same finish with a faint amber cast so it reads as "not attested"
      const inferred = base.clone();
      inferred.emissive = new THREE.Color("#d9a441");
      inferred.emissiveIntensity = 0.12;
      map.set(m.id, { base, inferred });
    }
    return map;
  }, [scene, jobId]);
}

export function UnitMesh({
  scene, jobId, showInferred, showCeilings, visibleLevels, onPick, onHover,
}: {
  scene: PropertySceneGraph;
  jobId: string;
  showInferred: boolean;
  showCeilings: boolean;
  visibleLevels: Set<string>;
  onPick?: (p: PickInfo, e: ThreeEvent<MouseEvent>) => void;
  onHover?: (p: PickInfo | null) => void;
}) {
  const groups = useMemo(() => buildGroups(scene), [scene]);
  const geos = useMemo(() => groups.map(toGeometry), [groups]);
  const mats = useSceneMaterials(scene, jobId);
  useEffect(() => () => geos.forEach((g) => g.dispose()), [geos]);

  const info = (g: MeshGroup, e: ThreeEvent<PointerEvent | MouseEvent>): PickInfo | null => {
    if (e.faceIndex === undefined || e.faceIndex === null) return null;
    const idx = g.buffers.triPiece[e.faceIndex];
    if (idx === undefined) return null;
    return { piece: scene.pieces[idx], pieceIndex: idx, point: e.point.clone() };
  };

  return (
    <group>
      {groups.map((g, i) => {
        if (!visibleLevels.has(g.levelId)) return null;
        if (g.inferred && !showInferred) return null;
        if (g.layer === "ceiling" && !showCeilings) return null;
        const m = mats.get(g.materialId);
        if (!m) return null;
        const glass = g.layer === "glass";
        return (
          <mesh
            key={g.key}
            geometry={geos[i]}
            material={g.inferred ? m.inferred : m.base}
            castShadow={!glass && g.layer !== "ceiling"}
            receiveShadow={!glass}
            renderOrder={glass ? 2 : 0}
            onClick={(e) => {
              e.stopPropagation();
              const p = info(g, e);
              if (p && onPick) onPick(p, e);
            }}
            onPointerMove={(e) => {
              e.stopPropagation();
              onHover?.(info(g, e));
            }}
            onPointerOut={() => onHover?.(null)}
          />
        );
      })}
    </group>
  );
}
