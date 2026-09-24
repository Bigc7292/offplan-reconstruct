"use client";
// The interactive viewer. Import with next/dynamic { ssr: false } (see ViewerDynamic.tsx):
// WebGL must never render on the server.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, Html, Lightformer, OrbitControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import type { PropertySceneGraph, SceneRoom, Vec3 } from "@/lib/schema";
import { UnitMesh, type PickInfo } from "@/scene/UnitMesh";
import { RoomHighlight } from "@/scene/RoomHighlight";
import { WalkControls, type WalkPose } from "@/scene/WalkControls";
import { MeasureTool, type Measure } from "@/scene/MeasureTool";

export type ViewMode = "dollhouse" | "walk" | "plan";
export type PlanOverlay = { url: string; pxPerM: number; originPx: { x: number; y: number }; imageW: number; imageH: number; elevationM: number };

export type ViewerProps = {
  scene: PropertySceneGraph;
  jobId: string;
  mode: ViewMode;
  showInferred: boolean;
  levelId: string | "all";
  selectedId: string | null;
  pulseKey?: number;
  jumpTo?: { roomId: string; n: number } | null;
  measuring: boolean;
  overlay?: PlanOverlay | null;
  overlayOpacity?: number;
  mood?: "day" | "dusk";
  compact?: boolean;
  watermark?: boolean;
  onSelect?: (p: PickInfo | null) => void;
  onRoomClick?: (room: SceneRoom) => void;
  onLockChange?: (locked: boolean) => void;
  onAzimuth?: (deg: number) => void;
  onPose?: (p: WalkPose) => void;
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
};

function Lighting({ mood }: { mood: "day" | "dusk" }) {
  const dusk = mood === "dusk";
  return (
    <>
      <hemisphereLight args={[dusk ? "#ffd9b0" : "#f4efe6", "#3a342c", dusk ? 0.35 : 0.55]} />
      <directionalLight
        position={dusk ? [-14, 7, 6] : [10, 18, 8]}
        intensity={dusk ? 1.2 : 2.2}
        color={dusk ? "#ffb773" : "#fff6e8"}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-25}
        shadow-camera-right={25}
        shadow-camera-top={25}
        shadow-camera-bottom={-25}
        shadow-bias={-0.0004}
        shadow-radius={6}
      />
      {/* procedural interior IBL (no network fetch): gallery softboxes + window strip */}
      <Environment resolution={256} frames={1}>
        <color attach="background" args={[dusk ? "#2b2320" : "#d9d4cb"]} />
        <Lightformer intensity={dusk ? 1.2 : 2.5} color={dusk ? "#ffc58f" : "#ffffff"} position={[0, 5, -9]} scale={[12, 3, 1]} />
        <Lightformer intensity={dusk ? 0.6 : 1.6} color="#fff3df" position={[-6, 3, 4]} rotation-y={Math.PI / 2} scale={[8, 2, 1]} />
        <Lightformer intensity={dusk ? 0.8 : 1.2} color={dusk ? "#ffa860" : "#f0f4ff"} position={[6, 2, 0]} rotation-y={-Math.PI / 2} scale={[8, 2, 1]} />
        <Lightformer intensity={0.8} form="ring" color="#fff" position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={4} />
      </Environment>
    </>
  );
}

function CameraRig({ scene, mode, levelId, jumpTo, onAzimuth }: Pick<ViewerProps, "scene" | "mode" | "levelId" | "jumpTo" | "onAzimuth">) {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const { camera, size: viewport } = useThree();
  const b = scene.bounds;
  const lvl = levelId === "all" ? null : scene.levels.find((l) => l.id === levelId);
  const center = useMemo(() => new THREE.Vector3((b.min.x + b.max.x) / 2, lvl ? lvl.elevationM : (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2), [b, lvl]);
  const size = Math.max(b.max.x - b.min.x, b.max.z - b.min.z, 6);

  useEffect(() => {
    if (mode === "dollhouse") {
      camera.position.set(center.x + size * 0.55, center.y + size * 0.9, center.z + size * 0.85);
      controls.current?.target.copy(center);
      controls.current?.update();
    } else if (mode === "plan") {
      // tiny z offset: looking straight down along camera.up is degenerate
      camera.position.set(center.x, center.y + 50, center.z + 0.01);
      camera.lookAt(center);
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const cam = camera as THREE.OrthographicCamera;
        cam.zoom = Math.min(viewport.width, viewport.height) / (size * 1.15);
        cam.updateProjectionMatrix();
      }
      controls.current?.target.copy(center);
      controls.current?.update();
    }
    // `camera` changes when the plan view swaps in its orthographic camera
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, levelId, scene.dossierHash, camera]);

  useEffect(() => {
    if (!jumpTo || mode === "walk") return;
    const r = scene.rooms.find((x) => x.id === jumpTo.roomId);
    if (!r || !controls.current) return;
    const t = new THREE.Vector3(r.centroid.x, r.centroid.y, r.centroid.z);
    const off = camera.position.clone().sub(controls.current.target).setLength(mode === "plan" ? 50 : 9);
    controls.current.target.copy(t);
    camera.position.copy(t.clone().add(off));
    controls.current.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo?.n]);

  if (mode === "walk") return null;
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      enableRotate={mode !== "plan"}
      maxPolarAngle={mode === "plan" ? 0 : Math.PI / 2.05}
      minDistance={2}
      maxDistance={120}
      onChange={() => {
        if (!onAzimuth || !controls.current) return;
        onAzimuth((controls.current.getAzimuthalAngle() * 180) / Math.PI);
      }}
    />
  );
}

/** Exposes world→screen projection for automated acceptance tests (window.__offplanProject). */
function Probe() {
  const { camera, gl } = useThree();
  useEffect(() => {
    const w = window as unknown as { __offplanProject?: (x: number, y: number, z: number) => { x: number; y: number } };
    w.__offplanProject = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      const r = gl.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    };
    return () => { delete w.__offplanProject; };
  }, [camera, gl]);
  return null;
}

function Overlay({ o, opacity }: { o: PlanOverlay; opacity: number }) {
  const tex = useMemo(() => {
    const t = new THREE.TextureLoader().load(o.url);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [o.url]);
  const w = o.imageW / o.pxPerM, h = o.imageH / o.pxPerM;
  const cx = (o.imageW / 2 - o.originPx.x) / o.pxPerM;
  const cy = (o.originPx.y - o.imageH / 2) / o.pxPerM;
  return (
    <mesh position={[cx, o.elevationM + 0.02, -cy]} rotation-x={-Math.PI / 2} renderOrder={3}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={tex} transparent opacity={opacity} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

export default function Viewer3D(props: ViewerProps) {
  const { scene, jobId, mode, showInferred, levelId, selectedId, measuring, overlay, mood = "day", compact } = props;
  const [measure, setMeasure] = useState<Measure>({ a: null, b: null });
  const [hover, setHover] = useState<PickInfo | null>(null);
  useEffect(() => { if (!measuring) setMeasure({ a: null, b: null }); }, [measuring]);

  const visibleLevels = useMemo(() => {
    if (levelId === "all") return new Set(scene.levels.map((l) => l.id));
    // stack: selected level and everything below it
    const sel = scene.levels.find((l) => l.id === levelId);
    return new Set(scene.levels.filter((l) => !sel || l.elevationM <= sel.elevationM + 1e-6).map((l) => l.id));
  }, [scene, levelId]);
  const walkLevel = levelId === "all" ? scene.spawn.levelId : levelId;
  const [walkStart, setWalkStart] = useState<{ position: Vec3; yawDeg: number }>(scene.spawn);
  useEffect(() => {
    const onLevel = scene.spawn.levelId === walkLevel ? scene.spawn : (() => {
      const r = scene.rooms.find((x) => x.levelId === walkLevel && x.program !== "balcony") ?? scene.rooms.find((x) => x.levelId === walkLevel);
      return r ? { position: r.centroid, yawDeg: 0 } : scene.spawn;
    })();
    setWalkStart(onLevel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.dossierHash, walkLevel]);
  useEffect(() => {
    if (mode !== "walk" || !props.jumpTo) return;
    const r = scene.rooms.find((x) => x.id === props.jumpTo!.roomId);
    if (r) setWalkStart({ position: r.centroid, yawDeg: walkStart.yawDeg });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jumpTo?.n]);

  const onPick = (p: PickInfo) => {
    if (measuring) {
      setMeasure((m) => (!m.a || m.b ? { a: p.point, b: null } : { ...m, b: p.point }));
      return;
    }
    props.onSelect?.(p);
  };

  return (
    <div className={`relative w-full h-full ${hover && !measuring ? "cursor-pointer" : measuring ? "cursor-crosshair" : ""}`}>
      <Canvas
        shadows
        dpr={[1, compact ? 1.5 : 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: mood === "dusk" ? 0.9 : 1.05 }}
        onCreated={({ gl }) => { if (props.canvasRef) props.canvasRef.current = gl.domElement; }}
        onPointerMissed={() => !measuring && props.onSelect?.(null)}
      >
        <color attach="background" args={[mood === "dusk" ? "#141110" : "#15130f"]} />
        {mode === "plan" ? <OrthographicCamera makeDefault near={0.1} far={500} position={[0, 50, 0]} /> : <PerspectiveCamera makeDefault fov={mode === "walk" ? 70 : 42} near={0.05} far={500} />}
        <Lighting mood={mood} />
        <UnitMesh scene={scene} jobId={jobId} showInferred={showInferred} showCeilings={mode === "walk"} visibleLevels={visibleLevels} onPick={onPick} onHover={setHover} />
        <RoomHighlight scene={scene} elementId={selectedId} pulseKey={props.pulseKey} />
        {overlay && mode === "plan" && <Overlay o={overlay} opacity={props.overlayOpacity ?? 0.55} />}
        <MeasureTool m={measure} />
        <Probe />
        {mode !== "walk" && (
          <>
            <ContactShadows position={[0, scene.bounds.min.y - 0.01, 0]} opacity={0.35} scale={80} blur={2.5} far={20} />
            {scene.rooms.filter((r) => visibleLevels.has(r.levelId) && (showInferred || !r.inferred)).map((r) => (
              <Html key={r.id} position={[r.labelPos.x, mode === "plan" ? r.centroid.y + 0.1 : r.labelPos.y, r.labelPos.z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "auto" }}>
                <button
                  onClick={() => props.onRoomClick?.(r)}
                  className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] backdrop-blur ${selectedId === r.id ? "border-champagne-400 bg-stone-950/90 text-champagne-300" : r.inferred ? "border-dashed border-inferred bg-stone-950/70 text-inferred" : "border-stone-600 bg-stone-950/70 text-stone-200"}`}
                >
                  {r.name} · {r.areaM2.toFixed(1)} m²
                </button>
              </Html>
            ))}
          </>
        )}
        {mode === "walk" ? <WalkControls scene={scene} levelId={walkLevel} start={walkStart} onLockChange={props.onLockChange} onPose={props.onPose} /> : <CameraRig scene={scene} mode={mode} levelId={levelId} jumpTo={props.jumpTo} onAzimuth={props.onAzimuth} />}
      </Canvas>
      {props.watermark && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] tracking-wider text-stone-400/80">{scene.disclaimer}</div>
      )}
      {scene.demo && <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 chip chip-inferred bg-stone-950/80">DEMO UNIT — not an extracted project</div>}
    </div>
  );
}
