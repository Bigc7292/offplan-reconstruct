"use client";
// First-person walk: pointer-lock mouse look + WASD, with circle-vs-segment collision
// against the scene graph's colliders (walls minus door openings).
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { PointerLockControls } from "@react-three/drei";
import type { PropertySceneGraph, Vec3 } from "@/lib/schema";

const RADIUS = 0.25;
const EYE = 1.6;
const SPEED = 1.6; // m/s walking, ×2 with shift

export type WalkPose = { x: number; z: number; yawDeg: number; roomId: string | null };

export function WalkControls({ scene, levelId, start, onLockChange, onPose }: { scene: PropertySceneGraph; levelId: string; start: { position: Vec3; yawDeg: number }; onLockChange?: (locked: boolean) => void; onPose?: (p: WalkPose) => void }) {
  const { camera } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const level = scene.levels.find((l) => l.id === levelId) ?? scene.levels[0];
  const cols = scene.colliders.filter((c) => c.levelId === level?.id);
  const polys = new Map(scene.rooms.map((r) => [r.id, r.polygon]));

  useEffect(() => {
    camera.position.set(start.position.x, (level?.elevationM ?? 0) + EYE, start.position.z);
    camera.rotation.set(0, (start.yawDeg * Math.PI) / 180, 0, "YXZ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.position.x, start.position.z, start.yawDeg, levelId]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { keys.current[e.code] = true; };
    const up = (e: KeyboardEvent) => { keys.current[e.code] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // look-direction hook for automated walkthrough tests: equivalent to turning with the mouse
  useEffect(() => {
    const w = window as unknown as { __offplanWalk?: unknown };
    w.__offplanWalk = {
      pose: () => {
        const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
        return { x: camera.position.x, y: -camera.position.z, yawDeg: (e.y * 180) / Math.PI };
      },
      face: (x: number, y: number) => camera.rotation.set(0, Math.atan2(-(x - camera.position.x), y + camera.position.z), 0, "YXZ"),
    };
    return () => { delete w.__offplanWalk; };
  }, [camera]);

  const fwd = new THREE.Vector3(), side = new THREE.Vector3();
  const lastPose = useRef(0);
  useFrame((state, dt) => {
    const k = keys.current;
    // Q/E turn without pointer lock (trackpads, tests)
    const turn = (k.KeyQ ? 1 : 0) - (k.KeyE ? 1 : 0);
    if (turn) {
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
      e.y += turn * 1.8 * Math.min(dt, 0.05);
      camera.quaternion.setFromEuler(e);
    }
    if (onPose && state.clock.elapsedTime - lastPose.current > 0.15) {
      lastPose.current = state.clock.elapsedTime;
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
      const room = scene.rooms.find((r) => r.levelId === level?.id && inRoom(r.id, camera.position.x, -camera.position.z));
      onPose({ x: camera.position.x, z: camera.position.z, yawDeg: (e.y * 180) / Math.PI, roomId: room?.id ?? null });
    }
    const f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    const s = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    if (!f && !s) return;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    side.crossVectors(fwd, camera.up).normalize();
    // sub-step so slow frames neither tunnel through walls nor slow the walk down
    const total = Math.min(dt, 0.2);
    const steps = Math.ceil(total / 0.04);
    for (let i = 0; i < steps; i++) {
      const v = (k.ShiftLeft || k.ShiftRight ? 2 : 1) * SPEED * (total / steps);
      const dx = (fwd.x * f + side.x * s) * v, dz = (fwd.z * f + side.z * s) * v;
      // move each axis separately so you slide along walls
      let px = camera.position.x + dx, pz = camera.position.z;
      if (collides(px, pz)) px = camera.position.x;
      pz = camera.position.z + dz;
      if (collides(px, pz)) pz = camera.position.z;
      camera.position.x = px;
      camera.position.z = pz;
    }
    camera.position.y = (level?.elevationM ?? 0) + EYE;
  });

  function inRoom(roomId: string, x: number, y: number) {
    const poly = polys.get(roomId);
    if (!poly) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function collides(x: number, z: number) {
    const py = -z; // world z → plan y
    for (const c of cols) {
      const ax = c.a.x, ay = c.a.y, bx = c.b.x, by = c.b.y;
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2)) : 0;
      const d = Math.hypot(x - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
      if (d < RADIUS + c.halfThickness) return true;
    }
    return false;
  }

  return <PointerLockControls onLock={() => onLockChange?.(true)} onUnlock={() => onLockChange?.(false)} selector="#walk-start" />;
}
