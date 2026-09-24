// Run model calls a few at a time: each gateway call takes tens of seconds, so running
// them one after another is what made a brochure take ~15 minutes.

/** Returns a wrapper that runs at most `n` of the wrapped functions at once. */
export function limiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    queue.shift()!();
  };
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
      next();
    });
  };
}

/** Settle a promise into a result object, so an early await can't turn it into an unhandled rejection. */
export function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
}

/** How many model calls run at once (LLM_CONCURRENCY, default 4). */
export const MODEL_CONCURRENCY = Math.max(1, Number(process.env.LLM_CONCURRENCY) || 4);
