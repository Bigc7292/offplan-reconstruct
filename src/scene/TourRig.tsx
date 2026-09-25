"use client";
// Drives the camera along the guided tour (src/lib/tour.ts). Plays in real time, or frame by frame
// when a recorder calls window.__offplanTour.seek(t) (scripts/video.ts uses this to make the MP4).
import { useEffect, useRef } from "react";
import type * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { tourAt, tourDuration, type TourShot } from "@/lib/tour";

export type TourState = { t: number; index: number; rendered: number; caption: number };
export type TourHandle = {
  duration: number;
  seek: (t: number) => void;
  /** seek, then resolve once two frames have been drawn at that time (for frame-by-frame recording) */
  step: (t: number) => Promise<TourState>;
  state: () => TourState;
};

export function TourRig({ shots, playing, restartKey, onShot, onEnd, fadeRef, captionRef }: {
  shots: TourShot[];
  playing: boolean;
  restartKey?: number;
  onShot: (index: number) => void;
  onEnd?: () => void;
  fadeRef: React.RefObject<HTMLDivElement | null>;
  captionRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { camera, invalidate } = useThree();
  const t = useRef(0);
  const manual = useRef(false);
  const index = useRef(-1);
  const rendered = useRef(0);
  const ended = useRef(false);
  const waiters = useRef<Array<{ until: number; resolve: () => void }>>([]);
  const total = tourDuration(shots);

  useEffect(() => { t.current = 0; ended.current = false; }, [restartKey]);
  useEffect(() => {
    const w = window as unknown as { __offplanTour?: TourHandle };
    const state = (): TourState => ({ t: t.current, index: index.current, rendered: rendered.current, caption: Number(captionRef.current?.style.opacity ?? 0) });
    const seek = (sec: number) => { manual.current = true; t.current = Math.max(0, Math.min(total, sec)); };
    w.__offplanTour = {
      duration: total,
      seek,
      state,
      step: (sec: number) => new Promise<TourState>((resolve) => {
        seek(sec);
        waiters.current.push({ until: rendered.current + 2, resolve: () => resolve(state()) });
        invalidate();
      }),
    };
    return () => { delete w.__offplanTour; };
  }, [total, captionRef, invalidate]);

  useFrame((_, dt) => {
    if (!manual.current && playing && t.current < total) t.current = Math.min(total, t.current + Math.min(dt, 0.1));
    const at = tourAt(shots, t.current);
    const shot = shots[at.index];
    camera.position.set(at.cam.pos.x, at.cam.pos.y, at.cam.pos.z);
    camera.lookAt(at.cam.target.x, at.cam.target.y, at.cam.target.z);
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera && cam.fov !== shot.fov) {
      cam.fov = shot.fov;
      cam.updateProjectionMatrix();
    }
    if (at.index !== index.current) {
      index.current = at.index;
      onShot(at.index);
    }
    if (fadeRef.current) fadeRef.current.style.opacity = at.fade.toFixed(3);
    if (captionRef.current) {
      const inT = Math.min(1, Math.max(0, (at.local - 0.35) / 0.5));
      const outT = Math.min(1, Math.max(0, (shot.duration - at.local - 0.3) / 0.4));
      captionRef.current.style.opacity = Math.min(inT, outT).toFixed(3);
    }
    rendered.current++;
    if (waiters.current.length) {
      const due = waiters.current.filter((x) => x.until <= rendered.current);
      waiters.current = waiters.current.filter((x) => x.until > rendered.current);
      // resolve after this frame is drawn; with on-demand rendering, ask for the next frame until then
      if (due.length) requestAnimationFrame(() => due.forEach((x) => x.resolve()));
      if (waiters.current.length) invalidate();
    }
    if (!manual.current && t.current >= total && !ended.current) {
      ended.current = true;
      onEnd?.();
    }
  });
  return null;
}
