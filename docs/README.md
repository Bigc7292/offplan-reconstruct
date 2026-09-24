# OffPlan Reconstruct: handoff notes

Written 2026-09-24. This folder is the full write-up of what was built, what was tested, what it cost and how it is deployed. `PROGRESS.md` at the repo root is the architecture and acceptance summary; start there for how the app works.

| Doc | What it covers |
|---|---|
| [oneprovider-gateway.md](oneprovider-gateway.md) | How the app talks to GPT 6 Astra through OneProvider, and every gateway quirk found |
| [cost-and-usage.md](cost-and-usage.md) | Where the $100 OneProvider balance went, as far as the app's own logs can show |
| [results-ninteen.md](results-ninteen.md) | What the Ninteen Riviera brochure produced on GPT 6 Astra, with timings |
| [deployment-railway.md](deployment-railway.md) | How the hosted copy on Railway is set up, and how to rebuild it |
| [backups/](backups/) | Output files from the test runs (3D model, room table, dossier, screenshots) |

## State on 2026-09-24

- **Code:** everything is on GitHub. `main` holds the original build. Branch `claude/gpt-6-astra-extraction-r6mobo` (draft PR #1) adds the OneProvider Responses path, retries, parallel model calls, the live 3D preview while a brochure is read, a Dockerfile and an optional site password.
- **AI model:** the OneProvider balance ran out at about 22:23 UTC. Every gateway call now fails with `429 insufficient_balance`, and the app falls back to the local extractor (text layer, OCR and heuristics) without erroring. Topping up at dashboard.oneprovider.dev brings the AI path back with no code change.
- **Hosting:** a copy runs on Railway from the PR branch, behind a site password. It has no `LLM_API_KEY` yet, so it runs without AI.
- **Test inputs:** three PDFs live in the project's shared files, not in this repo, because the repo is public. They are the Ninteen deck, the Al Barari renders and the Jasmine 6 title deed. The deed carries owner names, so it is never sent to a model gateway and never committed.

## What is left to do

1. Top up OneProvider (or switch provider, see below), then re-time a full Ninteen run with the parallel reads. The one timed parallel run (689 s) was spoiled by gateway errors and the balance running out mid-run.
2. Add `LLM_API_KEY` on the Railway `web` service so the hosted copy uses the model.
3. Rotate the OneProvider key. It was pasted into a chat message, so treat it as exposed (see cost-and-usage.md).
4. Merge PR #1 once reviewed. Railway then needs its source branch switched to `main`.
5. Known product gaps (from PROGRESS.md): traced room shapes are only roughly to scale until a reviewer runs "Calibrate scale"; CGI crops are not yet used as textures; the rooftop plan sometimes falls back to the local extractor when the gateway errors.

## Switching model provider

The extractor is behind one interface (`src/lib/llm.ts`), so another provider is a settings change, not a code change:

- **Claude directly:** set `ANTHROPIC_API_KEY` and leave the `LLM_*` variables empty.
- **Any OpenAI-compatible gateway:** set `LLM_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, and `LLM_API=responses` or `chat` to match what the model supports. `npm run llm-check` confirms the model answers.
- **No model:** leave everything empty. The local extractor reads facts and room names; geometry comes from tracing in the plan editor.

## Never put these in the repo

The repo is public. Keep out the OneProvider key, the Railway site password, any `.env.local`, the brochure PDFs and the title deed. `.gitignore` already excludes `.env*` (except `.env.example`) and `data/jobs/`.
