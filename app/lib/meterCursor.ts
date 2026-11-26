/**
 * The metering cursor persisted in `BillingState.lastMeteredCursor` — one string
 * column carrying the upstream usage cursor, the billing-cycle key and the
 * resolutions already counted in that cycle (so the plan's included allowance
 * is applied per cycle). Legacy rows hold a bare cursor string; that is read as
 * `{ cursor, cycleKey: null, cycleResolutions: 0 }`. Pure + tested.
 */
export interface MeterCursor {
  cursor: string | null;
  /** Billing-cycle identity (the Partner API `currentBillingCycle.startTime`). */
  cycleKey: string | null;
  /** Resolutions counted so far in `cycleKey` (billable or not). */
  cycleResolutions: number;
  /**
   * Paid plans: usage units already reported to Shopify (App Events `ai_resolution`) in
   * `cycleKey` — every post-trial resolution, up to the cap ceiling (plans.ts
   * `computeUsageReport`). Absent on cursors written before 2026-11-26; the meter then treats
   * that cycle's count as settled (usageBilling.ts), never catching up possible trial backlog.
   */
  cycleReported?: number;
  /**
   * Paid plans: when the free trial ended (Shopify's `trialEndsAt`, kept here so a later read
   * without it still never bills a resolution that ended during the trial).
   */
  trialEnd?: string;
  /**
   * Free plan only: the cycle's end (when the allowance resets) and whether the platform has
   * recorded the "allowance used — conversations go to your team" hold (`set_partner_shop_limit`).
   * Absent on paid-plan cursors, so their serialized form (the outbox's identity) is unchanged.
   */
  cycleEnd?: string | null;
  limitHeld?: boolean;
}

const EMPTY: MeterCursor = { cursor: null, cycleKey: null, cycleResolutions: 0 };

export function parseMeterCursor(raw: string | null | undefined): MeterCursor {
  if (!raw) return { ...EMPTY };
  if (!raw.startsWith("{")) return { ...EMPTY, cursor: raw };
  try {
    const j = JSON.parse(raw) as Partial<Record<keyof MeterCursor, unknown>> & { v?: unknown };
    if (j.v !== 1) return { ...EMPTY, cursor: raw };
    const out: MeterCursor = {
      cursor: typeof j.cursor === "string" && j.cursor ? j.cursor : null,
      cycleKey: typeof j.cycleKey === "string" && j.cycleKey ? j.cycleKey : null,
      cycleResolutions: typeof j.cycleResolutions === "number" && Number.isFinite(j.cycleResolutions) ? Math.max(0, Math.floor(j.cycleResolutions)) : 0,
    };
    if (typeof j.cycleEnd === "string" && j.cycleEnd) out.cycleEnd = j.cycleEnd;
    if (j.limitHeld === true) out.limitHeld = true;
    if (typeof j.trialEnd === "string" && Number.isFinite(Date.parse(j.trialEnd))) out.trialEnd = j.trialEnd;
    if (typeof j.cycleReported === "number" && Number.isSafeInteger(j.cycleReported) && j.cycleReported >= 0) out.cycleReported = j.cycleReported;
    return out;
  } catch {
    return { ...EMPTY, cursor: raw };
  }
}

export function serializeMeterCursor(c: MeterCursor): string {
  return JSON.stringify({
    v: 1, cursor: c.cursor, cycleKey: c.cycleKey, cycleResolutions: c.cycleResolutions,
    ...(c.cycleEnd ? { cycleEnd: c.cycleEnd } : {}),
    ...(c.limitHeld ? { limitHeld: true } : {}),
    ...(typeof c.cycleReported === "number" ? { cycleReported: c.cycleReported } : {}),
    ...(c.trialEnd ? { trialEnd: c.trialEnd } : {}),
  });
}
