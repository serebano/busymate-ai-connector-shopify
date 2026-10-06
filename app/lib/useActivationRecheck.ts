import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { startActivationRecheck } from "./activationRecheck";

/**
 * While `recheck` is on (`homeActivation().recheck` — the runtime is not yet
 * `ready`, whether or not the CTA is held), re-run the route's loaders by
 * themselves (see `startActivationRecheck`) and return `slow` once the loop has
 * run past the 5-minute fast phase. The caller gates the "taking longer" banner
 * on `activating && slow`, so a re-check that only keeps the status badge fresh
 * never shows a banner.
 *
 * The effect depends on `recheck` ONLY. The revalidator object changes
 * identity on every re-check (react-router 7), so it is read through a ref:
 * listing it as a dependency restarted the loop at tick 0 every 5 s and the
 * "taking longer" banner with Retry setup never rendered (#3718, re-review
 * defect 2). `test/activationRecheck.test.ts` drives this hook in a real data
 * router.
 */
export function useActivationRecheck(recheck: boolean): boolean {
  const revalidator = useRevalidator();
  const latest = useRef(revalidator);
  latest.current = revalidator;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!recheck) {
      setSlow(false);
      return undefined;
    }
    return startActivationRecheck({ revalidator: () => latest.current, onSlow: setSlow });
  }, [recheck]);
  return slow;
}
