/**
 * The Free plan's monthly allowance — "25 AI resolutions a month, then conversations route to
 * your team" (listing/pricing.json, the Shopify pricing page and the Billing page say exactly that).
 *
 * WHAT COUNTS, AND WHEN (decided 2026-11-26, docs/BILLING.md "Free plan limit"):
 *   - The Free allowance applies to a shop on the $0 Free plan AND to a shop that has not selected
 *     a plan yet ("No plan selected" — Free-plan limits apply until it does, billingGate.ts), so a
 *     store can never get unlimited AI answers by never choosing a plan.
 *   - The month is the shop's billing cycle: the Partner API `currentBillingCycle` of its Free
 *     contract when Shopify reports one; otherwise monthly windows anchored on the install date.
 *   - At the allowance the app records a hold on the Busymate AI workspace (`set_partner_shop_limit`,
 *     resets_at = the cycle end): the assistant stops answering and every new shopper conversation
 *     lands in the team's Conversations. The storefront chat itself stays on. A paid plan or the
 *     cycle end lifts it.
 *
 * Pure (tests import it directly).
 */
import { parseMeterCursor } from "./meterCursor";

export interface CycleWindow {
  /** ISO start — the cycle's identity (`MeterCursor.cycleKey`). */
  key: string;
  /** ISO end — when the allowance resets. */
  end: string;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The anchor's day/time in the month `offset` months after it (day clamped to the month's length). */
function shift(anchor: Date, offset: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + offset;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
  return new Date(Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()));
}

/** The monthly window anchored on `anchor` that contains `now` (a future anchor = the first window). */
export function monthlyWindow(anchor: Date, now: Date): CycleWindow {
  if (!(now > anchor)) return { key: anchor.toISOString(), end: shift(anchor, 1).toISOString() };
  let offset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  if (shift(anchor, offset) > now) offset -= 1;
  return { key: shift(anchor, offset).toISOString(), end: shift(anchor, offset + 1).toISOString() };
}

export interface FreeLimitState {
  reached: boolean;
  used: number;
  included: number;
  resetsAt: string | null;
}

/** Has a Free-plan shop used its allowance this cycle? */
export function freeLimitState(input: { included: number; used: number; resetsAt: string | null }): FreeLimitState {
  const used = Math.max(0, Math.floor(input.used));
  return { reached: used >= input.included, used, included: input.included, resetsAt: input.resetsAt };
}

/**
 * The merchant notice: a shop on the Free plan, or with no plan selected yet (Free-plan limits),
 * whose counted resolutions this cycle reached the allowance. Null otherwise (paid, pending,
 * frozen, under the allowance, or nothing measured yet). Read from the stored meter cursor.
 */
export function freeLimitNotice(
  billing: { status?: string | null; plan?: string | null; lastMeteredCursor?: string | null } | null | undefined,
  included: number,
): FreeLimitState | null {
  if (!billing?.lastMeteredCursor) return null;
  const status = String(billing.status ?? "inactive");
  const onFree = status === "active" ? String(billing.plan ?? "").toLowerCase() === "free" : !["pending", "frozen"].includes(status);
  if (!onFree) return null;
  const c = parseMeterCursor(billing.lastMeteredCursor);
  if (c.cycleEnd && Date.parse(c.cycleEnd) <= Date.now()) return null; // the cycle already reset
  const state = freeLimitState({ included, used: c.cycleResolutions, resetsAt: c.cycleEnd ?? null });
  return state.reached ? state : null;
}
