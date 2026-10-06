/**
 * Home's self re-check while "Turn on the storefront assistant" is held
 * (#3718 — Shopify review 5.1.2 + 5.1.3).
 *
 * While the assistant is still being activated, Home re-runs its loader by
 * itself: every 5 s for the first 5 minutes, then every 30 s for as long as the
 * hold lasts, and after 5 minutes it reports `slow` so the page switches to the
 * "Activation is taking longer than usual" banner with Retry setup.
 *
 * The loop OWNS its tick and reads the revalidator through a getter at every
 * tick — never an object captured once, and never a React effect dependency.
 * react-router 7 hands out a NEW `useRevalidator()` object whenever
 * `state.revalidation` changes (idle → loading → idle on every re-check), so an
 * effect that listed it restarted this loop at tick 0 every 5 s: the cadence
 * never slowed, `slow` never came, and a merchant held on a definite "no" read
 * "usually takes less than a minute" forever (re-review defect 2).
 */
import { recheckDelayMs, recheckIsSlow } from "./embedFrameable";

/** The part of react-router's `useRevalidator()` the loop needs. */
export interface RecheckRevalidator {
  readonly state: string;
  revalidate(): unknown;
}

export interface ActivationRecheckOptions {
  /** The CURRENT revalidator, read at every tick. */
  readonly revalidator: () => RecheckRevalidator;
  /** Called at every tick: has the hold lasted past the fast phase? */
  readonly onSlow: (slow: boolean) => void;
}

/** Start the loop. The returned function stops it (safe to call twice). */
export function startActivationRecheck(opts: ActivationRecheckOptions): () => void {
  let tick = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      tick += 1;
      opts.onSlow(recheckIsSlow(tick));
      const revalidator = opts.revalidator();
      // A re-check already in flight is not doubled; the next tick asks again.
      if (revalidator.state === "idle") {
        Promise.resolve(revalidator.revalidate()).catch(() => undefined);
      }
      schedule();
    }, recheckDelayMs(tick));
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
