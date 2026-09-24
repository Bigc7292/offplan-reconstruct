import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "sharp", "playwright-core"],
  experimental: { serverActions: { bodySizeLimit: "200mb" } },
};

export default nextConfig;
