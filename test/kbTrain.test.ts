import { describe, expect, it, vi } from "vitest";
import { createReingestScheduler, isKnowledgeRejection, trainTenant, type TrainDeps } from "../app/lib/kbTrain";
import type { KbSnapshot } from "../app/lib/kbSnapshot";

/**
 * The re-train core (webhook re-ingest + the "Re-train" button + install share
 * it): fetch the store snapshot → compress to knowledge_sources → ONE
 * publish_tenant_runtime carrying the SAME launch/embed origins the lifecycle
 * publishes (a re-train must never drop the origins) → persist the training
 * state. Errors are persisted on the tenant row and returned — never swallowed.
 */
const SNAPSHOT: KbSnapshot = {
  shop: "acme.myshopify.com",
  shopName: "Acme",
  products: [{ title: "Board", handle: "board", descriptionHtml: "<p>Fast.</p>", onlineStoreUrl: "https://acme.myshopify.com/products/board", priceRangeV2: { minVariantPrice: { amount: "99.00", currencyCode: "USD" } } }],
  policies: [{ type: "REFUND_POLICY", title: "Refunds", body: "<p>30 days</p>" }],
  pages: [],
  generatedAt: "2026-09-02T10:00:00.000Z",
};

const INPUT = { shop: "acme.myshopify.com", tenantId: "t_1", launchOrigins: ["https://shop-acme.busymate.ai"], embedOrigins: ["https://acme.myshopify.com"] };

function deps(over: Partial<TrainDeps> = {}) {
  const saved: Record<string, unknown>[] = [];
  const publishes: Record<string, unknown>[] = [];
  const d: TrainDeps = {
    fetchSnapshot: async () => SNAPSHOT,
    publish: async (_shop, _tenantId, opts) => {
      publishes.push(opts as Record<string, unknown>);
      return { ok: true, data: { revision: 7, knowledge_source_ids: ["k1", "k2"] } };
    },
    saveTraining: async (_shop, patch) => {
      saved.push(patch as unknown as Record<string, unknown>);
    },
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    log: () => {},
    ...over,
  };
  return { d, saved, publishes };
}

describe("trainTenant", () => {
  it("publishes knowledge_sources WITH the runtime origins and persists counts + trainedAt", async () => {
    const { d, saved, publishes } = deps();
    const out = await trainTenant(INPUT, d);
    expect(out.ok).toBe(true);
    expect(out.counts).toEqual({ products: 1, policies: 1, pages: 0 });
    expect(publishes).toHaveLength(1);
    expect(publishes[0].launchOrigins).toEqual(INPUT.launchOrigins);
    expect(publishes[0].embedOrigins).toEqual(INPUT.embedOrigins);
    const ks = publishes[0].knowledgeSources as { key: string }[];
    expect(ks.map((k) => k.key)).toEqual(["shopify:order-help", "shopify:policies", "shopify:products"]);
    expect(saved.at(-1)).toMatchObject({
      kbTrainedAt: new Date("2026-09-02T12:00:00.000Z"),
      kbError: null,
      kbProducts: 1,
      kbPolicies: 1,
      kbPages: 0,
      kbTruncated: false,
    });
    expect(typeof saved.at(-1)!.kbChars).toBe("number");
    expect(out.revision).toBe(7);
  });

  it("a snapshot fetch failure is persisted as kbError and returned (not swallowed), and nothing is published", async () => {
    const { d, saved, publishes } = deps({
      fetchSnapshot: async () => {
        throw new Error("no offline token for acme.myshopify.com — reinstall required");
      },
    });
    const out = await trainTenant(INPUT, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no offline token/);
    expect(publishes).toHaveLength(0);
    expect(saved.at(-1)).toMatchObject({ kbError: expect.stringMatching(/no offline token/) });
    expect(saved.at(-1)).not.toHaveProperty("kbTrainedAt");
  });

  it("a publish refusal is persisted as kbError with the edge's message", async () => {
    const { d, saved } = deps({ publish: async () => ({ ok: false, error: "knowledge_sources total content exceeds 40,000 characters (41000)" }) });
    const out = await trainTenant(INPUT, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/publish_tenant_runtime: knowledge_sources total/);
    expect(saved.at(-1)).toMatchObject({ kbError: expect.stringMatching(/exceeds 40,000/) });
  });

  it("an empty store publishes ONLY the order-help how-to (#2132) and records zero counts", async () => {
    const { d, saved, publishes } = deps({ fetchSnapshot: async () => ({ ...SNAPSHOT, products: [], policies: [], pages: [] }) });
    const out = await trainTenant(INPUT, d);
    expect(out.ok).toBe(true);
    const ks = publishes[0].knowledgeSources as { key: string }[];
    expect(ks.map((k) => k.key)).toEqual(["shopify:order-help"]);
    expect(saved.at(-1)).toMatchObject({ kbProducts: 0, kbPolicies: 0, kbPages: 0, kbError: null });
  });

  it("refuses (fail-closed) when there is no tenant id", async () => {
    const { d, publishes } = deps();
    const out = await trainTenant({ ...INPUT, tenantId: null }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no provisioned tenant/);
    expect(publishes).toHaveLength(0);
  });
});

describe("isKnowledgeRejection", () => {
  it("recognises the edge's knowledge_sources validation errors only", () => {
    expect(isKnowledgeRejection("knowledge_sources[0].key \"X\" is invalid")).toBe(true);
    expect(isKnowledgeRejection("publish_tenant_runtime knowledge_sources rejected: boom")).toBe(true);
    expect(isKnowledgeRejection("proof-of-shop verification failed")).toBe(false);
    expect(isKnowledgeRejection(undefined)).toBe(false);
  });
});

describe("createReingestScheduler (webhook debounce)", () => {
  it("coalesces a burst of product webhooks for one shop into ONE re-train after the quiet period", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async (_shop: string) => {});
      const s = createReingestScheduler({ run, delayMs: 1000 });
      s.schedule("a.myshopify.com", "products");
      s.schedule("a.myshopify.com", "products");
      s.schedule("b.myshopify.com", "products");
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1100);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(["a.myshopify.com", "b.myshopify.com"]);
      expect(s.pending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("order webhooks do not re-train (orders are read live through the connector)", () => {
    const run = vi.fn(async () => {});
    const s = createReingestScheduler({ run, delayMs: 10 });
    const r = s.schedule("a.myshopify.com", "orders");
    expect(r.scheduled).toBe(false);
    expect(s.pending()).toEqual([]);
  });

  it("a failing run is reported through onError, never thrown out of the timer", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const s = createReingestScheduler({
        run: async () => {
          throw new Error("ingest exploded");
        },
        delayMs: 10,
        onError,
      });
      s.schedule("a.myshopify.com", "products");
      await vi.advanceTimersByTimeAsync(50);
      expect(onError).toHaveBeenCalledWith("a.myshopify.com", expect.objectContaining({ message: "ingest exploded" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createReingestScheduler — scope grants", () => {
  it("a scopes_update re-trains like a product change (new scopes = newly readable knowledge)", async () => {
    const runs: string[] = [];
    const s = createReingestScheduler({ run: async (shop) => { runs.push(shop); }, delayMs: 5 });
    expect(s.schedule("s.myshopify.com", "scopes")).toEqual({ scheduled: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toEqual(["s.myshopify.com"]);
  });
});

describe("#52 — uninstall stops retraining; inactive shops are refused; errors are readable", () => {
  it("cancel drops a pending re-train before it runs", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      const s = createReingestScheduler({ run, delayMs: 1000 });
      s.schedule("acme.myshopify.com", "shop");
      expect(s.cancel("acme.myshopify.com")).toBe(true);
      expect(s.cancel("acme.myshopify.com")).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).not.toHaveBeenCalled();
      expect(s.pending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a thrown Response persists as 'Shopify <status>', never '[object Response]'", async () => {
    const { d, saved } = deps({ fetchSnapshot: async () => { throw new Response(null, { status: 401, statusText: "Unauthorized" }); } });
    const out = await trainTenant(INPUT, d);
    expect(out.error).toBe("Shopify 401 Unauthorized");
    expect(saved[0]).toEqual({ kbError: "Shopify 401 Unauthorized" });
  });

  it("retrainRefusal refuses inactive and suspended shops", async () => {
    vi.doMock("../app/db.server", () => ({ default: {} }));
    vi.doMock("../app/bmai.server", () => ({ publishTenantRuntime: vi.fn() }));
    const { retrainRefusal } = await import("../app/lib/ingest");
    expect(retrainRefusal({ provisionState: "published", inactiveAt: new Date(), inactiveReason: "shop_not_found" })).toMatch(/inactive \(shop_not_found\)/);
    expect(retrainRefusal({ provisionState: "suspended", inactiveAt: null })).toMatch(/uninstalled/);
    expect(retrainRefusal({ provisionState: "published", inactiveAt: null })).toBeNull();
    expect(retrainRefusal(null)).toBeNull();
  });
});
