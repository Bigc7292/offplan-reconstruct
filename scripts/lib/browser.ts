// Headless Chromium for screenshots and walkthrough videos. WebGL goes through Mesa (llvmpipe) when
// the machine has it, which is about 5x faster than Chromium's built-in SwiftShader; otherwise SwiftShader.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  const d = fs.existsSync(root) ? fs.readdirSync(root).find((x) => /^chromium-\d+$/.test(x)) : undefined;
  return d ? path.join(root, d, "chrome-linux", "chrome") : undefined;
}

const MESA = ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"];
const SWIFTSHADER = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

/** Launch Chromium with the fastest working WebGL backend; returns the browser and the GPU it reports. */
export async function launchBrowser(): Promise<{ browser: Browser; gpu: string }> {
  for (const args of process.env.GL_BACKEND === "swiftshader" ? [SWIFTSHADER] : [MESA, SWIFTSHADER]) {
    const browser = await chromium.launch({ executablePath: chromePath(), args });
    const page = await browser.newPage();
    const gpu = String(await page.evaluate(`(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return "";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "webgl2";
    })()`));
    await page.close();
    if (gpu) return { browser, gpu };
    await browser.close();
  }
  throw new Error("No WebGL in headless Chromium (tried Mesa and SwiftShader).");
}
