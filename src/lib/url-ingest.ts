// Listing URL ingest: full HTML, rendered screenshot (Playwright if a Chromium is available),
// every <img>, OG tags, JSON-LD (RealEstateListing etc.), visible body text, and linked brochure PDFs.
// Never scrapes behind logins: 401/403, login walls and captchas mark the source "blocked".
import fs from "node:fs";

export type UrlIngest = {
  finalUrl: string;
  status: number;
  blocked: boolean;
  blockReason?: string;
  html: string;
  title?: string;
  og: Record<string, string>;
  jsonLd: unknown[];
  images: Array<{ src: string; alt?: string }>;
  pdfLinks: string[];
  paragraphs: string[];
  screenshot?: Buffer;
};

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 OffPlanReconstruct/0.1";

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

export function parseHtml(html: string, baseUrl: string): Omit<UrlIngest, "finalUrl" | "status" | "blocked" | "html" | "screenshot"> {
  const abs = (u: string) => { try { return new URL(u, baseUrl).toString(); } catch { return u; } };
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "") || undefined;
  const og: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const p = attr(m[0], "property") ?? attr(m[0], "name");
    const c = attr(m[0], "content");
    if (p && c && /^(og:|twitter:|description$|keywords$)/i.test(p)) og[p.toLowerCase()] = c;
  }
  const jsonLd: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonLd.push(JSON.parse(m[1].trim())); } catch { /* keep going; malformed JSON-LD is common */ }
  }
  const images: Array<{ src: string; alt?: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const srcset = attr(m[0], "srcset")?.split(",").map((s) => s.trim().split(/\s+/)[0]).pop();
    const src = attr(m[0], "data-src") ?? srcset ?? attr(m[0], "src");
    if (!src || src.startsWith("data:")) continue;
    const u = abs(src);
    if (seen.has(u)) continue;
    seen.add(u);
    images.push({ src: u, alt: attr(m[0], "alt") });
  }
  if (og["og:image"] && !seen.has(abs(og["og:image"]))) images.unshift({ src: abs(og["og:image"]), alt: og["og:title"] });
  const pdfLinks = [...new Set([...html.matchAll(/<a\b[^>]*href=["']([^"']+\.pdf(\?[^"']*)?)["'][^>]*>/gi)].map((m) => abs(decode(m[1]))))];
  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const paragraphs = decode(body).split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 1);
  return { title, og, jsonLd, images, pdfLinks, paragraphs };
}

function detectBlock(status: number, html: string): string | undefined {
  if (status === 401 || status === 403) return `HTTP ${status}`;
  if (status === 429) return "rate limited (HTTP 429)";
  if (status >= 400) return `HTTP ${status}`;
  const lower = html.slice(0, 200_000).toLowerCase();
  if (/captcha|cf-challenge|are you a robot|access denied|verify you are human/.test(lower)) return "bot protection / captcha";
  if (/<input[^>]+type=["']password["']/.test(lower) && html.length < 60_000) return "login wall";
  return undefined;
}

function chromiumPath(): string | undefined {
  const cands = [process.env.CHROMIUM_PATH, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  try {
    const dirs = fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-"));
    for (const d of dirs) { const p = `/opt/pw-browsers/${d}/chrome-linux/chrome`; if (fs.existsSync(p)) return p; }
  } catch { /* none */ }
  return undefined;
}

async function screenshot(url: string): Promise<{ png: Buffer; html: string } | null> {
  const exe = chromiumPath();
  if (!exe) return null;
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, userAgent: UA });
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.waitForLoadState("domcontentloaded"));
      const png = await page.screenshot({ fullPage: true, type: "png" });
      const html = await page.content();
      return { png: Buffer.from(png), html };
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

export async function ingestUrl(url: string): Promise<UrlIngest> {
  let status = 0, html = "", finalUrl = url;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
    status = res.status;
    finalUrl = res.url || url;
    html = await res.text();
  } catch (e) {
    return { finalUrl, status: 0, blocked: true, blockReason: `could not fetch (${e instanceof Error ? e.message : String(e)})`, html: "", og: {}, jsonLd: [], images: [], pdfLinks: [], paragraphs: [] };
  }
  const blockReason = detectBlock(status, html);
  if (blockReason) return { finalUrl, status, blocked: true, blockReason, html, og: {}, jsonLd: [], images: [], pdfLinks: [], paragraphs: [] };
  const shot = await screenshot(finalUrl);
  // the rendered DOM usually carries more images/text than the raw HTML on JS-heavy listing sites
  const parsed = parseHtml(shot?.html && shot.html.length > html.length ? shot.html : html, finalUrl);
  return { finalUrl, status, blocked: false, html, screenshot: shot?.png, ...parsed };
}

export async function download(url: string, maxBytes = 60 * 1024 * 1024): Promise<{ data: Buffer; type: string } | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    return { data: buf, type: res.headers.get("content-type") ?? "" };
  } catch {
    return null;
  }
}

/** Flatten JSON-LD into "path: value" strings so every field becomes a fact candidate. */
export function flattenJsonLd(v: unknown, prefix = ""): Array<[string, string]> {
  if (v === null || v === undefined) return [];
  if (typeof v !== "object") return [[prefix, String(v)]];
  if (Array.isArray(v)) return v.flatMap((x, i) => flattenJsonLd(x, `${prefix}[${i}]`));
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (k.startsWith("@context") ? [] : flattenJsonLd(x, prefix ? `${prefix}.${k}` : k)));
}
