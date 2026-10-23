import { describe, expect, it, vi, beforeEach } from "vitest";

const rows = new Map<string, { plan: string; status: string }>();
vi.mock("../app/db.server", () => ({
  default: {
    shopTenant: { findUnique: async () => ({ shop: "s.myshopify.com" }) },
    billingState: {
      findUnique: async ({ where }: { where: { shop: string } }) => rows.get(where.shop) ?? null,
      upsert: async ({ where, create, update }: { where: { shop: string }; create: { plan?: string; status: string }; update: { plan?: string; status: string } }) => {
        const prev = rows.get(where.shop);
        const next = prev ? { ...prev, ...update } : { plan: "starter", ...create };
        rows.set(where.shop, next as { plan: string; status: string });
        return next;
      },
    },
  },
}));

import { syncBillingState } from "../app/lib/billingState.server";

const shop = "s.myshopify.com";
describe("#2631 syncBillingState reports the shoppers-visible plan to the platform on change", () => {
  beforeEach(() => rows.clear());
  it("first sync reports; an unchanged plan does not; a change does", async () => {
    const report = vi.fn(async () => true);
    await syncBillingState(shop, { status: "inactive", subscriptionId: null, plan: null }, report);
    expect(report).toHaveBeenLastCalledWith(shop, "free");
    await syncBillingState(shop, { status: "inactive", subscriptionId: null, plan: null }, report);
    expect(report).toHaveBeenCalledTimes(1);
    await syncBillingState(shop, { status: "pending", subscriptionId: null, plan: "scale" }, report);
    expect(report).toHaveBeenCalledTimes(1);
    await syncBillingState(shop, { status: "active", subscriptionId: "gid://x", plan: "scale" }, report);
    expect(report).toHaveBeenLastCalledWith(shop, "scale");
    await syncBillingState(shop, { status: "cancelled", subscriptionId: null, plan: null }, report);
    expect(report).toHaveBeenLastCalledWith(shop, "free");
  });
  it("a failing report never fails the billing sync", async () => {
    const report = vi.fn(async () => { throw new Error("mcp down"); });
    await expect(syncBillingState(shop, { status: "active", subscriptionId: "g", plan: "growth" }, report)).resolves.toBe(true);
  });
});
