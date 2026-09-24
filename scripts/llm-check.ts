// Checks the configured model gateway: lists its models, confirms LLM_MODEL is one of them,
// and makes one small structured call.   npx tsx --env-file=.env.local scripts/llm-check.ts
import * as z from "zod/v4";

const base = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
const key = process.env.LLM_API_KEY ?? "";
const model = process.env.LLM_MODEL ?? "";
if (!base || !key) { console.error("Set LLM_BASE_URL and LLM_API_KEY (see .env.example)."); process.exit(1); }

const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } }).catch((e) => { console.error(`Cannot reach ${base}: ${e.cause?.message ?? e}`); process.exit(1); });
const ids: string[] = res.ok ? ((await res.json()).data ?? []).map((m: { id: string }) => m.id) : [];
console.log(`${base}/v1/models → ${res.status}, ${ids.length} models`);
const near = ids.filter((i) => /gpt|astra/i.test(i));
if (near.length) console.log("GPT-family / astra models:", near.join(", "));
if (!model) { console.log("LLM_MODEL is not set: pick one of the ids above."); process.exit(1); }
console.log(ids.includes(model) ? `LLM_MODEL "${model}" is available.` : `LLM_MODEL "${model}" is NOT in the list.`);

process.env.LLM_PROVIDER = "openai";
const fs = await import("node:fs");
const path = await import("node:path");
fs.mkdirSync(path.join(process.env.DATA_DIR ?? "data/jobs", "llm-check"), { recursive: true });
const { callStructured } = await import("../src/lib/llm");
const out = await callStructured("llm-check", {
  task: "check", system: "You answer with JSON only.", prompt: "Give the number of rooms in a 2-bedroom apartment with a living room and a kitchen, as {\"rooms\": n}.",
  schema: z.object({ rooms: z.number() }), schemaName: "check", images: process.argv[2] ? [process.argv[2]] : undefined,
});
console.log("structured call ok:", out);
