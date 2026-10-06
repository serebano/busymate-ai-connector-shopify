/** One serialized drain, coalescing wakes without losing one that arrives in flight. */
export function createReingestWake(deps: { drain: () => Promise<void>; nextDelay: () => Promise<number>; fallbackMs?: number }) {
  const fallback = deps.fallbackMs ?? 30_000;
  let stopped = false, pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(wake, Math.max(0, Math.min(fallback, Number.isFinite(delay) ? delay : fallback)));
  };
  async function run() {
    pending = false;
    let delay = fallback;
    try { await deps.drain(); delay = await deps.nextDelay(); }
    catch { /* Health completion remains stale; fallback retries authoritative state. */ }
    finally { active = undefined; schedule(pending ? 0 : delay); }
  }
  function wake() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    if (active) { pending = true; return; }
    active = run();
  }
  return {
    wake,
    async stop() { stopped = true; if (timer) clearTimeout(timer); await active; },
  };
}
