"use client";
// Click two points on any surface → distance in metres.
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";

export type Measure = { a: THREE.Vector3 | null; b: THREE.Vector3 | null };

export function MeasureTool({ m }: { m: Measure }) {
  if (!m.a) return null;
  const pts = m.b ? [m.a, m.b] : [m.a, m.a];
  const mid = m.b ? m.a.clone().add(m.b).multiplyScalar(0.5) : m.a;
  return (
    <group>
      <mesh position={m.a}><sphereGeometry args={[0.05, 16, 16]} /><meshBasicMaterial color="#e6d3a8" depthTest={false} /></mesh>
      {m.b && <mesh position={m.b}><sphereGeometry args={[0.05, 16, 16]} /><meshBasicMaterial color="#e6d3a8" depthTest={false} /></mesh>}
      {m.b && <Line points={pts} color="#e6d3a8" lineWidth={2} depthTest={false} />}
      {m.b && (
        <Html position={mid} center zIndexRange={[20, 0]}>
          <div className="rounded bg-stone-950/90 border border-champagne-500 px-2 py-0.5 text-xs text-champagne-300 whitespace-nowrap">
            {m.a.distanceTo(m.b).toFixed(2)} m
          </div>
        </Html>
      )}
    </group>
  );
}
