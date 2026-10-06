import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 0.1.15 (owner item d, busymate-devtools#3995) — NO webhook route may answer 5xx
 * because the shop's offline session is EXPIRED or MISSING.
 *
 * `authenticate.webhook` loads the offline session and, under expiring offline
 * tokens, refreshes it first; after an uninstall (or for a shop whose refresh
 * token Shopify no longer honours) that refresh fails and the library throws a
 * 500 Response. Shopify retries, then DELETES the subscription after 8 failures
 * — the Dev Dashboard showed a 51.4 % webhook failure rate before 0.1.13 moved
 * app/uninstalled + GDPR off that path. This drives EVERY route's real action
 * with HMAC-signed deliveries while the session store is a dead end (a load
 * would throw, as the library does), and pins 200 per topic, 401 on a bad HMAC,
 * and that the session store is never read.
 */

const SECRET = "example-webhook-secret-not-real";
const shop = "probe-expired.myshopify.com";
process.env.SHOPIFY_API_SECRET = SECRET;

const spies = vi.hoisted(() => ({
  // The session-refreshing path the routes must never take.
  authenticateWebhook: vi.fn(async () => {
    throw new Response(undefined, { status: 500, statusText: "Internal Server Error" });
  }),
  loadSession: vi.fn(async () => {
    throw new Error("session store must not be read by a webhook route");
  }),
  sessionFindUnique: vi.fn(async () => {
    throw new Error("session store must not be read by a webhook route");
  }),
  sessionUpdateMany: vi.fn(async () => ({ count: 0 })),
  shopTenantFindUnique: vi.fn(async () => null),
  onAppUninstalled: vi.fn(async () => undefined),
  onShopRedact: vi.fn(async () => undefined),
  refreshStorefrontDomains: vi.fn(async () => null),
  scheduleReingest: vi.fn(async () => ({ scheduled: false, reason: "test" })),
  cancelReingest: vi.fn(async () => undefined),
  syncBillingState: vi.fn(async () => false),
}));

vi.mock("../app/db.server", () => ({
  default: {
    session: { findUnique: spies.sessionFindUnique, updateMany: spies.sessionUpdateMany, findMany: spies.sessionFindUnique },
    shopTenant: { findUnique: spies.shopTenantFindUnique },
  },
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: spies.authenticateWebhook, admin: vi.fn() },
  unauthenticated: { admin: spies.loadSession },
  sessionStorage: { loadSession: spies.loadSession, findSessionsByShop: spies.loadSession },
  onAppUninstalled: spies.onAppUninstalled,
}));
vi.mock("../app/bmai.server", () => ({
  onAppUninstalled: spies.onAppUninstalled,
  onShopRedact: spies.onShopRedact,
  exportTenantCustomerData: vi.fn(async () => ({ ok: false, error: "no tenant for shop" })),
  redactTenantCustomer: vi.fn(async () => ({ ok: false, error: "no tenant for shop" })),
  refreshStorefrontDomains: spies.refreshStorefrontDomains,
}));
vi.mock("../app/lib/ingest", () => ({ scheduleReingest: spies.scheduleReingest, cancelReingest: spies.cancelReingest }));
vi.mock("../app/lib/billingState.server", () => ({ syncBillingState: spies.syncBillingState }));

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function delivery(path: string, topic: string, payload: unknown, opts: { badHmac?: boolean } = {}): Request {
  const body = JSON.stringify(payload);
  return new Request(`https://store.busymate.ai${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": "2a4b6c8d-0000-4000-8000-000000000001",
      "x-shopify-api-version": "2026-07",
      "x-shopify-hmac-sha256": opts.badHmac ? sign(body, "wrong-secret") : sign(body),
    },
    body,
  });
}

async function statusOf(p: Promise<Response>): Promise<number> {
  try {
    return (await p).status;
  } catch (err) {
    if (err instanceof Response) return err.status;
    throw err;
  }
}

type RouteModule = { action: (args: { request: Request; params: Record<string, string>; context: unknown }) => Promise<Response> };

/** Topic → route file + delivery path + a Shopify-shaped payload. */
const DELIVERIES: Array<{ topic: string; file: string; path: string; payload: unknown }> = [
  { topic: "customers/data_request", file: "webhooks.compliance.tsx", path: "/webhooks/compliance", payload: { shop_id: 1, shop_domain: shop, customer: { id: 42, email: "x@example.com" }, orders_requested: [] } },
  { topic: "customers/redact", file: "webhooks.compliance.tsx", path: "/webhooks/compliance", payload: { shop_id: 1, shop_domain: shop, customer: { id: 42 }, orders_to_redact: [] } },
  { topic: "shop/redact", file: "webhooks.compliance.tsx", path: "/webhooks/compliance", payload: { shop_id: 1, shop_domain: shop } },
  { topic: "app/uninstalled", file: "webhooks.app.uninstalled.tsx", path: "/webhooks/app/uninstalled", payload: { id: 1, domain: shop } },
  { topic: "app/scopes_update", file: "webhooks.app.scopes_update.tsx", path: "/webhooks/app/scopes_update", payload: { previous: ["read_products"], current: ["read_products", "read_legal_policies"] } },
  { topic: "app_subscriptions/update", file: "webhooks.app_subscriptions.update.tsx", path: "/webhooks/app_subscriptions/update", payload: { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Growth", status: "CANCELLED" } } },
  { topic: "domains/create", file: "webhooks.domains.tsx", path: "/webhooks/domains", payload: { id: 1, host: "shop.example" } },
  { topic: "domains/update", file: "webhooks.domains.tsx", path: "/webhooks/domains", payload: { id: 1, host: "shop.example" } },
  { topic: "domains/destroy", file: "webhooks.domains.tsx", path: "/webhooks/domains", payload: { id: 1, host: "shop.example" } },
  { topic: "products/update", file: "webhooks.kb.products.tsx", path: "/webhooks/kb/products", payload: { id: 1, title: "Snowboard" } },
  { topic: "shop/update", file: "webhooks.kb.shop.tsx", path: "/webhooks/kb/shop", payload: { id: 1, name: "Acme", domain: "acme.example" } },
  { topic: "orders/updated", file: "webhooks.kb.orders.tsx", path: "/webhooks/kb/orders", payload: { id: 1 } },
];

async function routeFor(file: string): Promise<RouteModule> {
  return (await import(`../app/routes/${file.replace(/\.tsx$/, "")}`)) as RouteModule;
}

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockClear();
});

describe("webhook routes with an expired or missing offline session (0.1.15)", () => {
  it("the delivery table covers every webhook route file (derived, never a hand list)", () => {
    const files = readdirSync(join(__dirname, "..", "app", "routes")).filter((f) => f.startsWith("webhooks.") && f.endsWith(".tsx"));
    expect(new Set(DELIVERIES.map((d) => d.file))).toEqual(new Set(files));
  });

  for (const d of DELIVERIES) {
    it(`${d.topic} answers 200 without touching the session store, and 401 on a bad HMAC`, async () => {
      const route = await routeFor(d.file);
      const ok = await statusOf(route.action({ request: delivery(d.path, d.topic, d.payload), params: {}, context: {} }));
      expect(ok, `${d.topic} status`).toBe(200);
      const bad = await statusOf(route.action({ request: delivery(d.path, d.topic, d.payload, { badHmac: true }), params: {}, context: {} }));
      expect(bad, `${d.topic} bad HMAC`).toBe(401);
      expect(spies.authenticateWebhook, `${d.topic} took the session-refreshing path`).not.toHaveBeenCalled();
      expect(spies.loadSession, `${d.topic} read the session store`).not.toHaveBeenCalled();
      expect(spies.sessionFindUnique, `${d.topic} read the Session table`).not.toHaveBeenCalled();
    });
  }

  it("app/scopes_update writes the scope onto the offline session ROW by id (no load, no refresh)", async () => {
    const d = DELIVERIES.find((x) => x.topic === "app/scopes_update")!;
    const route = await routeFor(d.file);
    await route.action({ request: delivery(d.path, d.topic, d.payload), params: {}, context: {} });
    expect(spies.sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: `offline_${shop}`, shop, isOnline: false },
      data: { scope: "read_products,read_legal_policies" },
    });
    expect(spies.scheduleReingest).toHaveBeenCalledWith(shop, "scopes", "2a4b6c8d-0000-4000-8000-000000000001");
  });

  it("app/uninstalled and shop/redact still run their teardown; domains/* refreshes in the background", async () => {
    for (const topic of ["app/uninstalled", "shop/redact", "domains/update"]) {
      const d = DELIVERIES.find((x) => x.topic === topic)!;
      const route = await routeFor(d.file);
      expect(await statusOf(route.action({ request: delivery(d.path, d.topic, d.payload), params: {}, context: {} }))).toBe(200);
    }
    expect(spies.onAppUninstalled).toHaveBeenCalledWith(shop);
    expect(spies.onShopRedact).toHaveBeenCalledWith(shop);
    expect(spies.cancelReingest, "app/uninstalled stops retraining (#52)").toHaveBeenCalledWith(shop);
    expect(spies.refreshStorefrontDomains).toHaveBeenCalledWith(shop);
  });

  it("shop/update queues a debounced re-train (#52)", async () => {
    const d = DELIVERIES.find((x) => x.topic === "shop/update")!;
    const route = await routeFor(d.file);
    await route.action({ request: delivery(d.path, d.topic, d.payload), params: {}, context: {} });
    expect(spies.scheduleReingest).toHaveBeenCalledWith(shop, "shop", "2a4b6c8d-0000-4000-8000-000000000001");
  });

  it.each(["products/update", "shop/update", "app/scopes_update"])("%s refuses acknowledgement when durable enqueue fails", async (topic) => {
    const d = DELIVERIES.find((x) => x.topic === topic)!;
    const route = await routeFor(d.file);
    spies.scheduleReingest.mockRejectedValueOnce(new Error("synthetic queue unavailable"));
    await expect(route.action({ request: delivery(d.path, d.topic, d.payload), params: {}, context: {} })).rejects.toThrow("queue unavailable");
  });

  it("a bad HMAC never reaches an effect", async () => {
    for (const d of DELIVERIES) {
      const route = await routeFor(d.file);
      await statusOf(route.action({ request: delivery(d.path, d.topic, d.payload, { badHmac: true }), params: {}, context: {} }));
    }
    expect(spies.onAppUninstalled).not.toHaveBeenCalled();
    expect(spies.onShopRedact).not.toHaveBeenCalled();
    expect(spies.refreshStorefrontDomains).not.toHaveBeenCalled();
    expect(spies.syncBillingState).not.toHaveBeenCalled();
    expect(spies.scheduleReingest).not.toHaveBeenCalled();
    expect(spies.sessionUpdateMany).not.toHaveBeenCalled();
  });
});
