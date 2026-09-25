"use client";
// The interactive viewer. Import with next/dynamic { ssr: false } (see ViewerDynamic.tsx):
// WebGL must never render on the server.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, Html, Lightformer, OrbitControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { EffectComposer, N8AO, SMAA } from "@react-three/postprocessing";
import type { PropertySceneGraph, SceneRoom, Vec3 } from "@/lib/schema";
import { UnitMesh, type PickInfo } from "@/scene/UnitMesh";
import { RoomHighlight } from "@/scene/RoomHighlight";
import { WalkControls, type WalkPose } from "@/scene/WalkControls";
import { MeasureTool, type Measure } from "@/scene/MeasureTool";
import { roomViewpoint } from "@/lib/geom";
import { buildTour } from "@/lib/tour";
import { TourRig } from "@/scene/TourRig";

/** Stand near one end of the room looking down its length, instead of at the centroid facing a wall. */
function viewFrom(r: SceneRoom): { position: Vec3; yawDeg: number } {
  const vp = roomViewpoint(r.polygon);
  return { position: { x: vp.x, y: r.centroid.y, z: -vp.y }, yawDeg: vp.yawDeg };
}

/** Ground around the building at street level: lawn with a paved apron, so the villa sits on a site. */
function Site({ scene, dusk }: { scene: PropertySceneGraph; dusk: boolean }) {
  const street = [...scene.levels].sort((a, b) => Math.abs(a.elevationM) - Math.abs(b.elevationM))[0];
  const y = (street?.elevationM ?? 0) - 0.07;
  const b = scene.bounds;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  // lawn only: paving, planting and boundaries are not in the plans, so none are drawn
  return (
    <mesh rotation-x={-Math.PI / 2} position={[cx, y - 0.01, cz]} receiveShadow>
      <planeGeometry args={[400, 400]} />
      <meshStandardMaterial color={dusk ? "#3d4a33" : "#8aa06e"} roughness={1} />
    </mesh>
  );
}

export type ViewMode = "dollhouse" | "walk" | "plan" | "tour";
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
  /** tour mode: play/pause, restart counter, called when the tour finishes */
  tourPlaying?: boolean;
  tourRestart?: number;
  onTourEnd?: () => void;
  /** tour mode for video capture: no watermark chrome, captions sized for 16:9 frames */
  capture?: boolean;
};

function Exposure({ value }: { value: number }) {
  const gl = useThree((st) => st.gl);
  useEffect(() => { gl.toneMappingExposure = value; }, [gl, value]);
  return null;
}

function Lighting({ mood, interior }: { mood: "day" | "dusk"; interior: boolean }) {
  const dusk = mood === "dusk";
  return (
    <>
      <hemisphereLight args={[dusk ? "#ffd9b0" : "#f4efe6", "#6b6153", dusk ? 0.4 : interior ? 0.55 : 0.6]} />
      {/* rooms are lit from inside too (cove and downlights), otherwise walk views under a ceiling go murky */}
      {interior && <ambientLight intensity={dusk ? 0.25 : 0.18} color="#fff1dc" />}
      <directionalLight
        position={dusk ? [-14, 7, 6] : [10, 18, 8]}
        intensity={dusk ? 1.2 : interior ? 1.7 : 2.4}
        color={dusk ? "#ffb773" : "#fff6e8"}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-bias={-0.0004}
        shadow-radius={6}
      />
      {/* procedural interior IBL (no network fetch): gallery softboxes + window strip */}
      <Environment resolution={256} frames={1} environmentIntensity={interior ? 0.55 : 0.8}>
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
  // frame the floor being shown, not the whole plot (a basement car park can be twice a floor's size)
  const frame = useMemo(() => {
    const pts = scene.rooms.filter((r) => !lvl || r.levelId === lvl.id).flatMap((r) => r.polygon);
    if (!pts.length) return { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2, size: Math.max(b.max.x - b.min.x, b.max.z - b.min.z, 6) };
    const xs = pts.map((p) => p.x), zs = pts.map((p) => -p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2, size: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 6) };
  }, [scene.rooms, lvl, b]);
  const center = useMemo(() => new THREE.Vector3(frame.x, lvl ? lvl.elevationM : (b.min.y + b.max.y) / 2, frame.z), [frame, b, lvl]);
  const size = frame.size;

  useEffect(() => {
    if (mode === "dollhouse") {
      camera.position.set(center.x + size * 0.45, center.y + size * 0.8, center.z + size * 0.7);
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
  const tour = useMemo(() => (mode === "tour" ? buildTour(scene) : null), [mode, scene]);
  const [tourIdx, setTourIdx] = useState(0);
  const tourShot = tour?.[Math.min(tourIdx, tour.length - 1)];
  const fadeRef = useRef<HTMLDivElement | null>(null);
  const captionRef = useRef<HTMLDivElement | null>(null);
  const [measure, setMeasure] = useState<Measure>({ a: null, b: null });
  const [hover, setHover] = useState<PickInfo | null>(null);
  useEffect(() => { if (!measuring) setMeasure({ a: null, b: null }); }, [measuring]);

  const visibleLevels = useMemo(() => {
    if (tourShot) return new Set(tourShot.levels);
    if (levelId === "all") return new Set(scene.levels.map((l) => l.id));
    // stack: selected level and everything below it
    const sel = scene.levels.find((l) => l.id === levelId);
    return new Set(scene.levels.filter((l) => !sel || l.elevationM <= sel.elevationM + 1e-6).map((l) => l.id));
  }, [scene, levelId, tourShot]);
  const interior = mode === "walk" || tourShot?.kind === "room";
  const walkLevel = levelId === "all" ? scene.spawn.levelId : levelId;
  const [walkStart, setWalkStart] = useState<{ position: Vec3; yawDeg: number }>(scene.spawn);
  useEffect(() => {
    if (props.jumpTo) {
      const j = scene.rooms.find((x) => x.id === props.jumpTo!.roomId);
      if (j && j.levelId === walkLevel) { setWalkStart(viewFrom(j)); return; }
    }
    const spawnRoom = scene.spawn.levelId === walkLevel
      ? scene.rooms.find((r) => r.levelId === walkLevel && Math.hypot(r.centroid.x - scene.spawn.position.x, r.centroid.z - scene.spawn.position.z) < 0.01)
      : [...scene.rooms].filter((x) => x.levelId === walkLevel && x.program !== "balcony").sort((a, b) => b.computedAreaM2 - a.computedAreaM2)[0];
    setWalkStart(spawnRoom ? viewFrom(spawnRoom) : scene.spawn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.dossierHash, walkLevel]);
  useEffect(() => {
    if (mode !== "walk" || !props.jumpTo) return;
    const r = scene.rooms.find((x) => x.id === props.jumpTo!.roomId);
    if (r) setWalkStart(viewFrom(r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jumpTo?.n]);
  const showSite = mode !== "plan" && scene.levels.some((l) => visibleLevels.has(l.id) && l.elevationM >= -0.01);

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
        frameloop={props.capture ? "demand" : "always"}
        shadows
        dpr={[1, compact ? 1.5 : 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: mood === "dusk" ? 0.9 : 1.05 }}
        onCreated={({ gl }) => { if (props.canvasRef) props.canvasRef.current = gl.domElement; }}
        onPointerMissed={() => !measuring && mode !== "tour" && props.onSelect?.(null)}
      >
        <color attach="background" args={[mode === "plan" ? "#15130f" : mood === "dusk" ? "#2c2733" : "#dfe5e8"]} />
        {mode !== "plan" && <fog attach="fog" args={[mood === "dusk" ? "#2c2733" : "#dfe5e8", 60, 180]} />}
        {showSite && <Site scene={scene} dusk={mood === "dusk"} />}
        {mode === "plan" ? <OrthographicCamera makeDefault near={0.1} far={500} position={[0, 50, 0]} /> : <PerspectiveCamera makeDefault fov={tourShot?.fov ?? (mode === "walk" ? 70 : 42)} near={0.05} far={500} />}
        <Lighting mood={mood} interior={interior} />
        <Exposure value={mode === "plan" ? 1.0 : interior ? 0.92 : mood === "dusk" ? 0.9 : 1.0} />
        {/* ambient occlusion grounds furniture and darkens corners; SMAA replaces MSAA inside the composer */}
        {mode !== "plan" && (
          <EffectComposer multisampling={0}>
            <N8AO aoRadius={interior ? 0.9 : 1.6} distanceFalloff={interior ? 0.6 : 1.2} intensity={interior ? 2.4 : 2.0} halfRes quality="medium" />
            <SMAA />
          </EffectComposer>
        )}
        <UnitMesh scene={scene} jobId={jobId} showInferred={showInferred} showCeilings={tourShot ? tourShot.ceilings : mode === "walk"} visibleLevels={visibleLevels} onPick={onPick} onHover={setHover} />
        <RoomHighlight scene={scene} elementId={selectedId} pulseKey={props.pulseKey} />
        {overlay && mode === "plan" && <Overlay o={overlay} opacity={props.overlayOpacity ?? 0.55} />}
        <MeasureTool m={measure} />
        <Probe />
        {mode !== "walk" && mode !== "tour" && (
          <>
            {!showSite && <ContactShadows position={[0, scene.bounds.min.y - 0.01, 0]} opacity={0.35} scale={80} blur={2.5} far={20} />}
            {/* labels only for the floor being looked at, and not for cupboards and shafts, so they never pile up */}
            {scene.rooms.filter((r) => (showInferred || !r.inferred) && (r.id === selectedId || (levelId !== "all" && r.levelId === levelId && (r.areaM2 >= 4 || mode === "plan")))).map((r) => (
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
        {tour ? (
          <TourRig shots={tour} playing={props.tourPlaying ?? true} restartKey={props.tourRestart} onShot={setTourIdx} onEnd={props.onTourEnd} fadeRef={fadeRef} captionRef={captionRef} />
        ) : mode === "walk" ? (
          <WalkControls scene={scene} levelId={walkLevel} start={walkStart} onLockChange={props.onLockChange} onPose={props.onPose} />
        ) : (
          <CameraRig scene={scene} mode={mode} levelId={levelId} jumpTo={props.jumpTo} onAzimuth={props.onAzimuth} />
        )}
      </Canvas>
      {tourShot && (
        <>
          <div ref={captionRef} className={`pointer-events-none absolute left-0 right-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent ${props.capture ? "px-14 pb-12 pt-24" : "px-8 pb-8 pt-16"}`} style={{ opacity: 0 }} data-testid="tour-caption">
            <div className={`text-[10px] uppercase tracking-[0.3em] text-champagne-300 ${props.capture ? "text-xs" : ""}`}>{tourShot.kind === "room" ? "Inside" : tourShot.kind === "floor" ? "Floor" : "Walkthrough"}</div>
            <div className={`font-light text-white ${props.capture ? "text-4xl mt-1" : "text-2xl"}`}>{tourShot.title}</div>
            {tourShot.subtitle && <div className={`text-stone-200 ${props.capture ? "text-lg mt-1" : "text-sm"}`}>{tourShot.subtitle}</div>}
          </div>
          <div ref={fadeRef} className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: 1 }} />
        </>
      )}
      {props.watermark && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] tracking-wider text-stone-400/80">{scene.disclaimer}</div>
      )}
      {scene.demo && <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 chip chip-inferred bg-stone-950/80">DEMO UNIT — not an extracted project</div>}
    </div>
  );
}
