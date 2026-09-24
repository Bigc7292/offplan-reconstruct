"use client";
// WebGL only renders on the client.
import dynamic from "next/dynamic";

export const Viewer3D = dynamic(() => import("./Viewer3D"), {
  ssr: false,
  loading: () => <div className="flex h-full w-full items-center justify-center text-sm text-stone-500">Loading 3D viewer…</div>,
});
