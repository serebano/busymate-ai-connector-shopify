import prisma from "../db.server";
import { platformPlanOf, type PlatformPlan, type SubscriptionState } from "./billingSync";

/**
 * Persist a resolved subscription state onto the shop's BillingState row so
 * `resolveBillingAccess()` (loader) reflects reality. Idempotent upsert keyed by
 * shop. Skips when there is no ShopTenant yet (BillingState FKs to it) — a
 * subscription event without an install is unexpected and nothing to attach to.
 *
 * A `null` plan is written as "free" only when the state says there is NO
 * contract (`inactive`/`cancelled`) — a pending/active state without a matched
 * plan keeps the previously stored plan (never silently downgrades a paid plan
 * because a handle failed to match).
 */
export async function syncBillingState(
  shop: string,
  state: SubscriptionState,
  report: (shop: string, plan: PlatformPlan) => Promise<unknown> = reportShopPlanLazy,
): Promise<boolean> {
  const tenant = await prisma.shopTenant.findUnique({ where: { shop }, select: { shop: true } });
  if (!tenant) return false;
  const before = await prisma.billingState.findUnique({ where: { shop }, select: { plan: true, status: true, subscriptionId: true } });
  if (isStaleTermination(before, state)) {
    // A plan change makes Shopify cancel the OLD contract and activate the new one;
    // both `app_subscriptions/update` webhooks land within ~100 ms, often on
    // different pods, in no guaranteed order. A late "cancelled" for the replaced
    // contract must not overwrite the newer active plan (2026-11-26 billing matrix).
    console.log(`[billing] ignored stale ${state.status} for ${state.subscriptionId} shop=${shop} (current ${before?.subscriptionId})`);
    return true;
  }
  const data: { status: string; subscriptionId?: string | null; plan?: string } = { status: state.status };
  if (state.subscriptionId) data.subscriptionId = state.subscriptionId;
  if (state.plan) data.plan = state.plan;
  else if (state.status === "inactive" || state.status === "cancelled") {
    data.plan = "free";
    data.subscriptionId = null;
  }
  const after = await prisma.billingState.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
    select: { plan: true, status: true },
  });
  // #2631 — tell the platform when the shoppers-visible plan changes (best-effort,
  // never blocks billing; the next sync or reinstall reports again).
  const next = platformPlanOf(after);
  if (next !== null && (before === null || platformPlanOf(before) !== next)) {
    await report(shop, next).catch((e) => console.warn(`[billing] plan report failed for ${shop}: ${e instanceof Error ? e.message : String(e)}`));
  }
  return true;
}

/**
 * True when `incoming` terminates (cancelled/declined/expired) a subscription
 * that is NOT the one stored as live — i.e. the replaced contract of a plan
 * change. Only an event naming a concrete, different subscription id is stale;
 * the Admin reconcile's "no contract" state carries no id and always applies.
 */
export function isStaleTermination(
  before: { status?: string | null; subscriptionId?: string | null } | null | undefined,
  incoming: SubscriptionState,
): boolean {
  if (incoming.status !== "cancelled" && incoming.status !== "inactive") return false;
  if (!incoming.subscriptionId || !before?.subscriptionId) return false;
  if (incoming.subscriptionId === before.subscriptionId) return false;
  return before.status === "active" || before.status === "pending" || before.status === "frozen";
}

/** The live reporter, loaded lazily so this module's tests never load the MCP client. */
async function reportShopPlanLazy(shop: string, plan: PlatformPlan): Promise<unknown> {
  const { reportShopPlan } = await import("../bmai.server");
  return reportShopPlan(shop, plan);
}

/** The stored billing state for a shop (or null before any sync). */
export async function readBillingState(shop: string) {
  return prisma.billingState.findUnique({ where: { shop } });
}
