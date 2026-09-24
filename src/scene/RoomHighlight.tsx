"use client";
// Glowing overlay on every piece belonging to the selected element (room floor, wall, opening…).
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { PropertySceneGraph } from "@/lib/schema";
import { pieceBuffers } from "./geometry";

export function RoomHighlight({ scene, elementId, pulseKey }: { scene: PropertySceneGraph; elementId: string | null; pulseKey?: number }) {
  const geo = useMemo(() => {
    if (!elementId) return null;
    const idxs = scene.pieces.map((p, i) => (p.elementId === elementId && p.elementKind !== "slab" && p.elementKind !== "ceiling" ? i : -1)).filter((i) => i >= 0);
    if (!idxs.length) return null;
    const b = pieceBuffers(scene, idxs);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(b.normals, 3));
    g.setIndex(b.indices);
    return g;
  }, [scene, elementId]);
  useEffect(() => () => geo?.dispose(), [geo]);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const started = useRef(0);
  useEffect(() => { started.current = performance.now(); }, [pulseKey, elementId]);
  useFrame(() => {
    if (!mat.current) return;
    const t = (performance.now() - started.current) / 1000;
    const pulse = t < 2.4 ? 0.25 + 0.3 * Math.abs(Math.sin(t * Math.PI * 1.5)) : 0.28;
    mat.current.opacity = pulse;
  });
  if (!geo) return null;
  return (
    <mesh geometry={geo} renderOrder={5}>
      <meshBasicMaterial ref={mat} color="#e6d3a8" transparent opacity={0.3} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  );
}
