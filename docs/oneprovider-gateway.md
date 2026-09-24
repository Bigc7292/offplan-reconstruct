# Running extraction on GPT 6 Astra through OneProvider

OneProvider (`https://api.oneprovider.dev`) is a third-party gateway that serves many models behind OpenAI- and Anthropic-compatible endpoints. The app uses it for page classification, facts, floor plans and materials when these are set:

```
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.oneprovider.dev
LLM_API_KEY=<your key>
LLM_MODEL=gpt-6-astra
LLM_API=responses
LLM_REASONING_EFFORT=low
LLM_CONCURRENCY=4          # optional, model calls in flight at once
```

## Quirks found on 2026-09-24, and what the code does about each

| Quirk | Effect | Handling in the code |
|---|---|---|
| `gpt-6-astra` answers only on `/v1/responses` | `/v1/chat/completions` returns 502 for it | `LLM_API=responses` routes calls to `callResponses()` in `src/lib/llm.ts` |
| The gateway ignores `text.format` (JSON Schema reply format) | The model sometimes replies in prose or asks a question back | The JSON Schema is repeated in the prompt, and every reply is validated with Zod |
| Requests whose first byte takes over ~30 s are cut off with 502 | Plan pages at default reasoning effort always failed | Requests stream (`stream: true`), and `LLM_REASONING_EFFORT=low` |
| Intermittent 502 and `400 upstream_error` | Random calls fail | Up to 5 attempts with backoff of 2 s, 4 s, 8 s and 10 s; retries force `low` effort |
| `429 insufficient_balance` once the balance is spent | All calls fail | Retries give up and the stage falls back to the local extractor, so a job still finishes |
| `/v1/models` answers without a key | `llm-check` listing models does not prove the key works | `npm run llm-check` also makes one tiny real call |

Every model call is logged per job to `data/jobs/<id>/model-calls.jsonl` with its task, prompt, images, duration, token usage or error.

## Running in a Claude Code cloud environment

The key is stored as an environment credential for host `api.oneprovider.dev`, and the egress proxy injects it. `LLM_API_KEY` can then be any placeholder, but Node's `fetch` bypasses the proxy unless it is told to use it:

```
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npm start
```

Without `NODE_USE_ENV_PROXY=1` the gateway sees the placeholder and returns 401.

## Speed

The first end-to-end run made model calls one at a time and took about 14 minutes for the 14-page Ninteen deck: about 4 min to sort pages, 7 min for 4 floor plans and 1.5 min for facts. Single calls took 10 to 170 s.

Commit 80c36a2 changed that:

- Page classification, plan reads and material reads run 4 at a time (`src/lib/concurrency.ts`). Results are still applied in page order, so the output does not depend on which call finishes first.
- Materials start before facts and plans and are awaited at the end.
- Page sorting dropped from about 4 min to about 1 min.
- While a brochure is read, the job page shows a live 3D preview (`LivePreview.tsx`, served by `/api/jobs/[id]/preview`). It rebuilds after each floor is read.

A clean full-run timing is still owed. The one parallel run hit gateway errors and then the balance ran out.
