import { describe, expect, it } from "vitest";
import {
  matchPlanId,
  normalizeSubscriptionStatus,
  subscriptionStateFromInstallation,
  subscriptionStateFromPlanHandle,
  subscriptionStateFromWebhook,
} from "../app/lib/billingSync";

/**
 * Billing status sync — the normalizer + payload extractors that make
 * resolveBillingAccess() reflect a REAL subscription. Sources (in priority order):
 * Partner API activeSubscription (partnerApi.test.ts), the App Pricing redirect
 * `plan_handle`, and the legacy Billing-API webhook / currentAppInstallation.
 */
describe("subscription status normalization", () => {
  const cases: Array<[string, string]> = [
    ["ACTIVE", "active"],
    ["PENDING", "pending"],
    ["ACCEPTED", "pending"],
    ["FROZEN", "frozen"],
    ["CANCELLED", "cancelled"],
    ["DECLINED", "inactive"],
    ["EXPIRED", "inactive"],
    ["", "inactive"],
    ["something-unknown", "inactive"],
  ];
  for (const [raw, expected] of cases) {
    it(`${raw || "(empty)"} → ${expected}`, () => {
      expect(normalizeSubscriptionStatus(raw)).toBe(expected);
    });
  }
});

describe("plan-id matching", () => {
  it("matches by handle/id and by display name (incl. Free), else null", () => {
    expect(matchPlanId("starter")).toBe("starter");
    expect(matchPlanId("Growth")).toBe("growth");
    expect(matchPlanId("Free")).toBe("free");
    expect(matchPlanId("FREE")).toBe("free");
    expect(matchPlanId("Enterprise")).toBeNull();
    expect(matchPlanId(null)).toBeNull();
  });
});

describe("App Pricing redirect (plan_handle) extraction", () => {
  it("a known plan_handle ⇒ pending state for that plan (confirmed by the Partner API afterwards)", () => {
    expect(subscriptionStateFromPlanHandle("growth")).toEqual({ status: "pending", subscriptionId: null, plan: "growth" });
    expect(subscriptionStateFromPlanHandle("free")).toEqual({ status: "pending", subscriptionId: null, plan: "free" });
  });
  it("an unknown/missing plan_handle ⇒ null (nothing to record)", () => {
    expect(subscriptionStateFromPlanHandle("enterprise")).toBeNull();
    expect(subscriptionStateFromPlanHandle(null)).toBeNull();
    expect(subscriptionStateFromPlanHandle("")).toBeNull();
  });
});

describe("app_subscriptions/update webhook extraction (legacy Billing API)", () => {
  it("maps status + captures the subscription GID and plan", () => {
    const state = subscriptionStateFromWebhook({
      app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/99", name: "Growth", status: "ACTIVE" },
    });
    expect(state).toEqual({ status: "active", subscriptionId: "gid://shopify/AppSubscription/99", plan: "growth" });
  });
  it("a declined subscription becomes inactive", () => {
    expect(subscriptionStateFromWebhook({ app_subscription: { status: "DECLINED" } }).status).toBe("inactive");
  });
  it("a malformed payload fails safe to inactive", () => {
    expect(subscriptionStateFromWebhook({}).status).toBe("inactive");
    expect(subscriptionStateFromWebhook(null).status).toBe("inactive");
  });
});

describe("currentAppInstallation.activeSubscriptions extraction (legacy fallback)", () => {
  it("prefers the ACTIVE subscription", () => {
    const state = subscriptionStateFromInstallation({
      currentAppInstallation: {
        activeSubscriptions: [
          { id: "gid://shopify/AppSubscription/1", name: "Starter", status: "PENDING" },
          { id: "gid://shopify/AppSubscription/2", name: "Scale", status: "ACTIVE" },
        ],
      },
    });
    expect(state).toEqual({ status: "active", subscriptionId: "gid://shopify/AppSubscription/2", plan: "scale" });
  });
  it("no subscriptions ⇒ inactive", () => {
    expect(subscriptionStateFromInstallation({ currentAppInstallation: { activeSubscriptions: [] } })).toEqual({
      status: "inactive",
      subscriptionId: null,
      plan: null,
    });
  });
});

describe("#2631 platformPlanOf — the plan the platform records (Powered-by link)", () => {
  it("active paid plans (a trial is ACTIVE) report that plan", async () => {
    const { platformPlanOf } = await import("../app/lib/billingSync");
    expect(platformPlanOf({ plan: "scale", status: "active" })).toBe("scale");
    expect(platformPlanOf({ plan: "Starter", status: "active" })).toBe("starter");
    expect(platformPlanOf({ plan: "growth", status: "active" })).toBe("growth");
  });
  it("no row, free, cancelled, frozen or inactive report free; pending reports nothing", async () => {
    const { platformPlanOf } = await import("../app/lib/billingSync");
    expect(platformPlanOf(null)).toBe("free");
    expect(platformPlanOf({ plan: "free", status: "active" })).toBe("free");
    expect(platformPlanOf({ plan: "scale", status: "cancelled" })).toBe("free");
    expect(platformPlanOf({ plan: "scale", status: "frozen" })).toBe("free");
    expect(platformPlanOf({ plan: "starter", status: "inactive" })).toBe("free");
    expect(platformPlanOf({ plan: "scale", status: "pending" })).toBeNull();
  });
});
