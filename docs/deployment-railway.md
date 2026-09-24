# Hosted copy on Railway

Set up 2026-09-24 in colin's Railway account. The public URL and the site password are in the project thread, not here, because this repo is public.

## Layout

| Item | Value |
|---|---|
| Project | `offplan-reconstruct` |
| Environment | `production` |
| Service | `web`, built from the repo's `Dockerfile` |
| Source | GitHub `Bigc7292/offplan-reconstruct`, branch `claude/gpt-6-astra-extraction-r6mobo`; every push redeploys |
| Volume | `jobs`, mounted at `/data` (job folders survive redeploys) |
| Domain | a generated `*.up.railway.app` domain on port 3000 |

The Docker image is `node:22-bookworm-slim` with Tesseract (English and Arabic), Chromium for URL screenshots, `npm ci` and `npm run build`, started with `next start` on `$PORT`.

## Variables on the `web` service

| Variable | Value |
|---|---|
| `PORT` | `3000` |
| `DATA_DIR` | `/data/jobs` |
| `APP_PASSWORD` | the site password (visitors log in with any user name and this password) |
| `LLM_PROVIDER` | `openai` |
| `LLM_BASE_URL` | `https://api.oneprovider.dev` |
| `LLM_MODEL` | `gpt-6-astra` |
| `LLM_API` | `responses` |
| `LLM_REASONING_EFFORT` | `low` |
| `LLM_API_KEY` | **not set yet.** colin adds the OneProvider key here in the Railway dashboard. Until then the app runs without AI |

Once the key is set, the app header shows "gpt-6-astra via api.oneprovider.dev".

## Rebuild from scratch

1. New Railway project, then a service from this GitHub repo. Railway picks up the `Dockerfile`.
2. Add a volume mounted at `/data`.
3. Set the variables above, then generate a domain on port 3000.
4. After PR #1 merges, switch the service's source branch to `main`.

## Plan limits hit on the way

On the free/Hobby plan Railway allows 2 projects, 5 services per project and 0 volume backups. To make room, colin deleted an older Railway project (potlock) on 2026-09-24. Its service layout was written down first; that note lives in the project's shared files (`potlock-backup/potlock-railway-setup.md`), not in this repo, because it describes a different project. Its database could not be backed up: the plan allows no volume backups and the connector sees variable names only.

