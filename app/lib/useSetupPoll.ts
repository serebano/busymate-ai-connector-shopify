import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

/** States in which the install lifecycle is still running (Home's loader state). */
export function isSettingUp(state: string): boolean {
  return state === "pending" || state === "provisioning";
}

export const SETUP_POLL_MS = 1_500;
export const SETUP_POLL_MAX = 40; // ~60 s, then the 5 s activation loop keeps going

/**
 * src#2624 final — while the install lifecycle runs (it takes ~2 s server-side,
 * but the first Home paint can land before it finishes), re-read the loader every
 * 1.5 s, at most SETUP_POLL_MAX times. A re-check in flight is never doubled.
 */
export function useSetupPoll(active: boolean): void {
  const revalidator = useRevalidator();
  const latest = useRef(revalidator);
  latest.current = revalidator;
  useEffect(() => {
    if (!active) return undefined;
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      if (n > SETUP_POLL_MAX) { clearInterval(id); return; }
      if (latest.current.state === "idle") Promise.resolve(latest.current.revalidate()).catch(() => undefined);
    }, SETUP_POLL_MS);
    return () => clearInterval(id);
  }, [active]);
}
