# Where the OneProvider balance went

colin topped up $100 on OneProvider on 2026-09-24. The balance ran out at about 22:23 UTC the same day, and every call since returns `429 insufficient_balance`.

## What the app's own logs account for

Every model call the app makes is logged with its token usage. These are all the gateway calls made by this app in the build environment that day:

| Job | Calls | Succeeded | Input tokens | Output tokens | Notes |
|---|---|---|---|---|---|
| 36348ce0 | 28 | 16 | 37,107 | 24,482 | Parallel run; 502s, 400s, then the 429 when the balance ran out |
| 3a9ce3cd | 28 | 24 | 41,285 | 11,080 | |
| 49462ccd | 28 | 14 | 83,499 | 1,346 | Materials replied in prose before the schema-in-prompt fix |
| 8ef234bd | 28 | 27 | 61,103 | 18,980 | The 13/13 acceptance run |
| llm-check | 2 | 1 | 62 | 40 | Connection check |
| **Total** | **114** | **82** | **223,056** | **55,928** | 88 minutes of model time in all |

About 280,000 tokens in total. At typical frontier-model list prices that is single-digit dollars, not $100. Even at several times list price it would not reach $100.

Two caveats make the logged total a floor, not an exact figure:

- A retried call logs only its last attempt, so up to 4 earlier attempts per call are not counted. Most of those failed before the model ran (502 at the gateway), but some may have been billed.
- The gateway adds its own hidden prompt. Chat-completions calls showed about 4,400 prompt tokens that the app never sent, and the response metadata named a gateway "agent" wrapper. The Responses endpoint may do the same.

## Where the rest most likely went

The app's logs cannot see these, so they are inferences to check against the OneProvider dashboard's usage page:

1. **Other sessions in the project.** A second thread ran its own GPT 6 Astra brochure test the same day before it was stopped as a duplicate, and its calls are not in these logs.
2. **The key was exposed.** It was pasted into a project chat message. Anyone who saw it could have used it, so rotate it in the OneProvider dashboard whatever the usage page shows.
3. **Gateway pricing.** OneProvider may charge a markup, a per-request fee or reasoning tokens that it does not report back in `usage`.

## Keeping spend down next time

- Run one model job at a time. Two brochure runs in parallel doubles the burn and makes the gateway error more.
- Keep `LLM_REASONING_EFFORT=low` for this gateway.
- Check `data/jobs/<id>/model-calls.jsonl` after a run. It has the tokens for every call.
- Test changes with the local extractor first (leave the `LLM_*` variables empty), and use the model only for the final run.
- Set a spend cap or low-balance alert in the OneProvider dashboard if it offers one.
