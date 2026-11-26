/**
 * A missing/failed measurement is not a zero-resolution billing cycle — but a
 * genuinely OBSERVED zero (a store the assistant simply hasn't resolved
 * anything for yet, or a Free-plan store, or a fresh cycle) IS a real, known
 * fact and must render "0 resolutions this cycle", never "unavailable"
 * (#19/#2835 review-store bug: a zero-usage store showed "currently
 * unavailable" forever, because `meterShop`'s zero-resolution and Free-plan
 * paths never populate `cycleKey` — this function used to require a truthy
 * `cycleKey` as a proxy for "a real measurement happened," which a valid,
 * fully-validated `v:1` payload with a safe-integer `cycleResolutions` already
 * proves on its own; `cycleKey` is meterShop's OWN cycle-reset bookkeeping,
 * never a signal about whether the count is trustworthy for display).
 */
export function measuredCycleResolutions(raw: string | null | undefined, error?: string | null, liveCycleKey?: string | null): number | null {
  if (error || !raw) return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; cycleResolutions?: unknown; cycleKey?: unknown };
    if (!value || typeof value !== "object" || value.v !== 1 || !Number.isSafeInteger(value.cycleResolutions) || (value.cycleResolutions as number) < 0) {
      return null;
    }
    // A new billing cycle has started (Shopify's live `currentBillingCycle.startTime` differs from
    // the cycle the stored count belongs to) and the meter has not counted anything in it yet:
    // the current cycle's usage is 0, not last cycle's count (review-test-7, 2026-11-26).
    if (liveCycleKey && typeof value.cycleKey === "string" && value.cycleKey && !sameInstant(value.cycleKey, liveCycleKey)) return 0;
    return value.cycleResolutions as number;
  } catch {
    return null;
  }
}

/** Same instant whatever the ISO spelling; non-dates (e.g. `trial:<end>`) compare as strings. */
function sameInstant(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = Date.parse(a);
  return Number.isFinite(ta) && ta === Date.parse(b);
}
