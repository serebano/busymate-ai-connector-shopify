import type { SubscriptionStatus } from "./billingGate";
import { PLANS, planByHandle } from "./plans";

/**
 * Subscription-state extractors. Sources (src#2624 reviewer F24):
 *   1. `currentAppInstallation.activeSubscriptions` — THE truth (it lists App
 *      Pricing contracts; empty after an uninstall cancelled them)
 *   2. the App Pricing redirect `plan_handle` (pending until #1 confirms it)
 *   3. Partner API `activeSubscription` — enrichment only (trial end, usage); it
 *      keeps returning a cancelled contract until its period ends
 *   4. `app_subscriptions/update` webhook (legacy Billing-API contracts)
 * Anything unknown fails safe to `inactive` (⇒ Free; the widget stays on).
 */
export function normalizeSubscriptionStatus(raw: string | null | undefined): SubscriptionStatus {
  switch (String(raw ?? "").toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "PENDING":
    case "ACCEPTED":
      return "pending";
    case "FROZEN":
      return "frozen";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    case "DECLINED":
    case "EXPIRED":
    default:
      return "inactive";
  }
}

/** Match a plan handle OR display name to one of our plan ids, or null. */
export function matchPlanId(name: string | null | undefined): string | null {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return null;
  const byHandle = planByHandle(n);
  if (byHandle) return byHandle.id;
  const byName = PLANS.find((p) => p.name.toLowerCase() === n);
  return byName ? byName.id : null;
}

export interface SubscriptionState {
  status: SubscriptionStatus;
  subscriptionId: string | null;
  plan: string | null;
}

/**
 * The App Pricing redirect (`?plan_handle=<handle>` on the plan's redirect URL)
 * ⇒ a PENDING state for that plan, confirmed by the Partner API on the same
 * request. Unknown/missing handle ⇒ null (nothing to record).
 */
export function subscriptionStateFromPlanHandle(planHandle: string | null | undefined): SubscriptionState | null {
  const plan = matchPlanId(planHandle);
  if (!plan) return null;
  return { status: "pending", subscriptionId: null, plan };
}

interface WebhookSubscription {
  admin_graphql_api_id?: string;
  name?: string;
  status?: string;
}

/** Extract the billing state from an `app_subscriptions/update` webhook payload. */
export function subscriptionStateFromWebhook(payload: unknown): SubscriptionState {
  const sub = ((payload as { app_subscription?: WebhookSubscription })?.app_subscription ?? {}) as WebhookSubscription;
  return {
    status: normalizeSubscriptionStatus(sub.status),
    subscriptionId: sub.admin_graphql_api_id ?? null,
    plan: matchPlanId(sub.name),
  };
}

interface InstallationSubscription {
  id?: string;
  name?: string;
  status?: string;
}

/**
 * Extract the billing state from a `currentAppInstallation.activeSubscriptions`
 * query. Prefers an ACTIVE row; falls back to the first (e.g. PENDING); no
 * subscriptions ⇒ `inactive` (Shopify only returns active/pending here).
 */
export function subscriptionStateFromInstallation(data: unknown): SubscriptionState {
  const subs =
    ((data as { currentAppInstallation?: { activeSubscriptions?: InstallationSubscription[] } })
      ?.currentAppInstallation?.activeSubscriptions ?? []) as InstallationSubscription[];
  const active = subs.find((s) => String(s.status).toUpperCase() === "ACTIVE") ?? subs[0] ?? null;
  if (!active) return { status: "inactive", subscriptionId: null, plan: null };
  return {
    status: normalizeSubscriptionStatus(active.status),
    subscriptionId: active.id ?? null,
    plan: matchPlanId(active.name),
  };
}

/**
 * busymate-ai-src#2631 — the plan the platform records for this shop's workspace
 * (it decides the Free-plan "Powered by" link in the storefront chat). An ACTIVE
 * paid subscription (a trial is ACTIVE) → that plan; no contract, cancelled,
 * frozen or declined → "free"; PENDING (approval not finished) → null = report
 * nothing yet, so a half-finished approval never changes what shoppers see.
 */
export type PlatformPlan = "free" | "starter" | "growth" | "scale";
export function platformPlanOf(row: { plan?: string | null; status?: string | null } | null | undefined): PlatformPlan | null {
  if (!row) return "free";
  const status = String(row.status ?? "inactive");
  if (status === "pending") return null;
  const plan = String(row.plan ?? "").toLowerCase();
  if (status === "active" && (plan === "starter" || plan === "growth" || plan === "scale")) return plan;
  return "free";
}
