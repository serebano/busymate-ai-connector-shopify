import { reingestRetryDelay, type DurableReingestStore, type ReingestLease } from "./reingestQueue";
import type { TrainOutcome } from "./kbTrain";

export interface ReingestWorkerDeps {
  store: DurableReingestStore;
  /** Must stop its owned child and resolve/reject only once that child exits on abort. */
  run: (lease: ReingestLease, signal: AbortSignal) => Promise<TrainOutcome>;
  timeoutMs?: number;
  heartbeatMs?: number;
}

/** One lease, bounded execution, and nonce-checked settlement. No hidden retry loop. */
export async function processReingestLease(lease: ReingestLease, deps: ReingestWorkerDeps): Promise<TrainOutcome> {
  const controller = new AbortController();
  let lost = false;
  let renewing = false;
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120_000);
  const heartbeat = setInterval(async () => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    try {
      if (!await deps.store.renew(lease)) { lost = true; controller.abort(); }
    } catch { lost = true; controller.abort(); }
    finally { renewing = false; }
  }, deps.heartbeatMs ?? 30_000);
  try {
    if (!await deps.store.owns(lease)) { lost = true; throw new Error("lease_lost"); }
    const out = await deps.run(lease, controller.signal);
    if (lost || controller.signal.aborted) throw new Error(lost ? "lease_lost" : "attempt_timeout");
    const settled = out.ok
      ? await deps.store.complete(lease)
      : await deps.store.retry(lease, reingestRetryDelay(lease.attempt), "training_failed");
    if (!settled) { lost = true; throw new Error("lease_lost"); }
    return out;
  } catch {
    if (!lost) await deps.store.retry(lease, reingestRetryDelay(lease.attempt), controller.signal.aborted ? "attempt_timeout" : "attempt_failed").catch(() => false);
    // Persist only a classified code; the child may have seen sensitive provider errors.
    return { ok: false, error: lost ? "Training lease changed; work remains queued." : "Training attempt failed; retry remains queued.", counts: { products: 0, policies: 0, pages: 0 }, fetched: { products: 0, policies: 0, pages: 0 }, totalChars: 0, truncated: false };
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}
