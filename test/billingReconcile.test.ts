import { describe, expect, it, vi, beforeEach } from "vitest";

const synced: Array<{ status: string; plan: string | null }> = [];
vi.mock("../app/lib/billingState.server", () => ({ syncBillingState: async (_s: string, st: { status: string; plan: string | null }) => { synced.push(st); return true; } }));
const partner = vi.fn();
vi.mock("../app/lib/partnerApi", async (orig) => ({ ...(await orig<typeof import("../app/lib/partnerApi")>()), appGidFromEnv: () => "gid://shopify/App/1", fetchActiveSubscription: (...a: unknown[]) => partner(...a) }));
import { reconcileBilling } from "../app/lib/billingReconcile.server";

const gql = (subs: unknown[]) => async () => new Response(JSON.stringify({ data: { shop: { id: "gid://shopify/Shop/9" }, currentAppInstallation: { activeSubscriptions: subs } } }));
const cancelledPartner = { ok: true, subscription: { cancelAtEndOfCycle: true, trialEndsAt: "2026-11-06T22:00:00Z", currentBillingCycle: null, items: [{ handle: "scale", usage: null }], legacySubscriptionId: "gid://shopify/AppSubscription/29737123925" } };

describe("src#2624 reviewer F24 — the plan is Shopify's activeSubscriptions, never the cache or the Partner API", () => {
  beforeEach(() => { synced.length = 0; partner.mockReset(); });
  it("after reinstall: no active subscription ⇒ inactive (no plan), even though the Partner API still returns the cancelled contract", async () => {
    partner.mockResolvedValue(cancelledPartner);
    const r = await reconcileBilling("s.myshopify.com", gql([]), null);
    expect(synced.at(-1)).toMatchObject({ status: "inactive", plan: null });
    expect(r.source).toBe("admin");
    expect(r.trialEndsAt).toBeNull();
  });
  it("an active Scale contract ⇒ active scale, enriched only from the SAME contract", async () => {
    partner.mockResolvedValue({ ...cancelledPartner, subscription: { ...cancelledPartner.subscription, legacySubscriptionId: "gid://shopify/AppSubscription/75" } });
    const r = await reconcileBilling("s.myshopify.com", gql([{ id: "gid://shopify/AppSubscription/75", name: "Scale", status: "ACTIVE" }]), null);
    expect(synced.at(-1)).toMatchObject({ status: "active", plan: "scale" });
    expect(r.trialEndsAt).toBe("2026-11-06T22:00:00Z");
  });
  it("right after a plan_handle redirect with no contract yet ⇒ stays pending", async () => {
    await reconcileBilling("s.myshopify.com", gql([]), "growth");
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ status: "pending", plan: "growth" });
  });
  it("an unreadable Admin answer keeps the stored state and reports unverified", async () => {
    const r = await reconcileBilling("s.myshopify.com", async () => new Response(JSON.stringify({ errors: [{}] })), null);
    expect(synced).toHaveLength(0);
    expect(r.unverified).toBeTruthy();
  });
});
