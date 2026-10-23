import { subscriptionStateFromInstallation, subscriptionStateFromPlanHandle } from "./billingSync";
import { syncBillingState } from "./billingState.server";
import { appGidFromEnv, fetchActiveSubscription, subscriptionStateFromPartnerApi } from "./partnerApi";

export type AdminGraphql = (query: string) => Promise<Response>;

/**
 * Reconcile the LIVE plan state into BillingState (Req 1.2.1/1.2.2).
 *
 * THE TRUTH is the shop's own `currentAppInstallation.activeSubscriptions` (Admin
 * API — it lists App Pricing contracts too). src#2624 reviewer F24: after an
 * uninstall Shopify CANCELS the subscription; on reinstall `activeSubscriptions`
 * is empty and Shopify's pricing page asks to "Select a plan", but the Partner
 * API `activeSubscription` still returned that cancelled contract
 * (`cancelAtEndOfCycle: true`, trial end in the future) and the app kept showing
 * "Scale · Trial · Done". The Partner API is now enrichment only (trial end,
 * usage) for the SAME contract Admin reports as active — never a source of a plan.
 *
 *   1. the App Pricing redirect `plan_handle` (just picked) ⇒ pending until Admin confirms
 *   2. Admin `activeSubscriptions` ⇒ active plan, or NONE ⇒ no plan selected
 *   3. Partner API ⇒ trialEndsAt / usageQuantity for that contract
 * Non-fatal: an unreadable Admin answer leaves the stored state and reports `unverified`.
 */
export async function reconcileBilling(shop: string, graphql: AdminGraphql, planHandle: string | null, opts: { enrich?: boolean } = {}) {
  let chosen: string | null = null;
  const fromRedirect = subscriptionStateFromPlanHandle(planHandle);
  if (fromRedirect) {
    await syncBillingState(shop, fromRedirect);
    chosen = fromRedirect.plan;
  }
  let source: "admin" | "stored" = "stored";
  let unverified: string | null = null;
  let trialEndsAt: string | null = null;
  let usageQuantity: number | null = null;
  try {
    const resp = await graphql(`#graphql
      query ActiveSubscriptions { shop { id } currentAppInstallation { activeSubscriptions { id name status } } }`);
    const body = (await resp.json()) as { data?: { shop?: { id?: string } } & Record<string, unknown>; errors?: unknown };
    if (!body.data || !(body.data as { currentAppInstallation?: unknown }).currentAppInstallation) throw new Error("activeSubscriptions unreadable");
    const state = subscriptionStateFromInstallation(body.data);
    // No contract right after a redirect ⇒ Shopify is still finalizing; keep pending.
    if (!(state.status === "inactive" && fromRedirect)) await syncBillingState(shop, state);
    source = "admin";
    const appGid = appGidFromEnv();
    const shopGid = body.data.shop?.id ?? null;
    if (opts.enrich !== false && state.status === "active" && state.subscriptionId && appGid && shopGid) {
      const live = await fetchActiveSubscription({ appGid, shopGid });
      if (live.ok && live.subscription && live.subscription.legacySubscriptionId === state.subscriptionId) {
        const p = subscriptionStateFromPartnerApi(live.subscription);
        trialEndsAt = p.trialEndsAt;
        usageQuantity = p.usageQuantity;
      }
    }
  } catch (err) {
    unverified = err instanceof Error ? err.message : String(err);
    console.warn(`[billing] reconcile failed shop=${shop}: ${unverified}`);
  }
  return { chosen, source, unverified, trialEndsAt, usageQuantity };
}
