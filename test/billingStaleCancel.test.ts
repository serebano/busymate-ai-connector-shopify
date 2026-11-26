import { describe, expect, it, vi, beforeEach } from "vitest";

type Row = { plan: string; status: string; subscriptionId: string | null };
const rows = new Map<string, Row>();
vi.mock("../app/db.server", () => ({
  default: {
    shopTenant: { findUnique: async () => ({ shop: "s.myshopify.com" }) },
    billingState: {
      findUnique: async ({ where }: { where: { shop: string } }) => rows.get(where.shop) ?? null,
      upsert: async ({ where, create, update }: { where: { shop: string }; create: Partial<Row>; update: Partial<Row> }) => {
        const prev = rows.get(where.shop);
        const next = (prev ? { ...prev, ...update } : { plan: "free", subscriptionId: null, ...create }) as Row;
        rows.set(where.shop, next);
        return next;
      },
    },
  },
}));

import { isStaleTermination, syncBillingState } from "../app/lib/billingState.server";

const shop = "s.myshopify.com";
const OLD = "gid://shopify/AppSubscription/1";
const NEW = "gid://shopify/AppSubscription/2";

describe("plan change: app_subscriptions/update webhooks out of order (billing matrix 2026-11-26)", () => {
  beforeEach(() => rows.clear());

  it("a late CANCELLED for the replaced contract does not overwrite the new active plan", async () => {
    const report = vi.fn(async () => true);
    rows.set(shop, { plan: "starter", status: "active", subscriptionId: OLD });
    await syncBillingState(shop, { status: "active", subscriptionId: NEW, plan: "growth" }, report);
    await syncBillingState(shop, { status: "cancelled", subscriptionId: OLD, plan: "starter" }, report);
    expect(rows.get(shop)).toEqual({ plan: "growth", status: "active", subscriptionId: NEW });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(shop, "growth");
  });

  it("in-order events still converge on the new plan", async () => {
    rows.set(shop, { plan: "starter", status: "active", subscriptionId: OLD });
    await syncBillingState(shop, { status: "cancelled", subscriptionId: OLD, plan: "starter" }, async () => true);
    expect(rows.get(shop)?.status).toBe("cancelled");
    await syncBillingState(shop, { status: "active", subscriptionId: NEW, plan: "growth" }, async () => true);
    expect(rows.get(shop)).toEqual({ plan: "growth", status: "active", subscriptionId: NEW });
  });

  it("a cancel of the CURRENT contract (merchant cancels, uninstall) still applies", async () => {
    rows.set(shop, { plan: "growth", status: "active", subscriptionId: NEW });
    await syncBillingState(shop, { status: "cancelled", subscriptionId: NEW, plan: "growth" }, async () => true);
    expect(rows.get(shop)?.status).toBe("cancelled");
  });

  it("the Admin reconcile's 'no contract' state (no id) always applies", async () => {
    rows.set(shop, { plan: "growth", status: "active", subscriptionId: NEW });
    await syncBillingState(shop, { status: "inactive", subscriptionId: null, plan: null }, async () => true);
    expect(rows.get(shop)).toEqual({ plan: "free", status: "inactive", subscriptionId: null });
  });

  it("isStaleTermination: only a terminal event naming a different id while one is live", () => {
    const live = { status: "active", subscriptionId: NEW };
    expect(isStaleTermination(live, { status: "cancelled", subscriptionId: OLD, plan: "starter" })).toBe(true);
    expect(isStaleTermination(live, { status: "inactive", subscriptionId: OLD, plan: null })).toBe(true);
    expect(isStaleTermination(live, { status: "active", subscriptionId: OLD, plan: "starter" })).toBe(false);
    expect(isStaleTermination(live, { status: "cancelled", subscriptionId: NEW, plan: "growth" })).toBe(false);
    expect(isStaleTermination({ status: "cancelled", subscriptionId: NEW }, { status: "cancelled", subscriptionId: OLD, plan: null })).toBe(false);
    expect(isStaleTermination(null, { status: "cancelled", subscriptionId: OLD, plan: null })).toBe(false);
  });
});
