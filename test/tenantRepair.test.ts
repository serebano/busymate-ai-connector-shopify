import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPublishedTenant,
  createRepairGate,
  missingStorefrontHosts,
  publishedTenantRepair,
  type RepairDecision,
} from "../app/lib/tenantRepair";
import { runtimeReadiness } from "../app/lib/runtimeReadiness";

/**
 * #3718 (Shopify review 5.1.2, adversarial review defects 2 + 3) — afterAuth no
 * longer re-provisions a live tenant, so a PUBLISHED row that went wrong on its
 * own must be detected and repaired: an orphaned tenant (the demo store) and a
 * storefront domain added after the last publish. Only definite answers repair.
 */
const ready = { state: "ready" as const, detail: "" };
const row = { shop: "demo.myshopify.com", bmaiTenantId: "t-1", customDomain: null as string | null, tenantUnreachableAt: null };

describe("publishedTenantRepair", () => {
  it("the platform's orphan answer repairs, with no meter flag", () => {
    const readiness = runtimeReadiness("t-1", { ok: false, error: "tenant integration administration denied" });
    expect(publishedTenantRepair({ readiness })).toMatchObject({ reason: "orphaned" });
  });

  it("the meter's unreachable flag still repairs", () => {
    expect(publishedTenantRepair({ readiness: null, tenantUnreachableAt: new Date() })).toMatchObject({ reason: "orphaned" });
  });

  it("a fresh storefront domain the allowlist lacks repairs", () => {
    expect(publishedTenantRepair({ readiness: ready, storedDomains: "shop.example", freshHosts: ["shop.example", "www.shop.example"] }))
      .toEqual({ reason: "domains", detail: "storefront domain(s) not in the published allowlist: www.shop.example" });
  });

  it("nothing to repair: live, domains covered, or reads unknown", () => {
    expect(publishedTenantRepair({ readiness: ready, storedDomains: "www.shop.example", freshHosts: ["WWW.Shop.Example."] })).toBeNull();
    expect(publishedTenantRepair({ readiness: { state: "unverified", detail: "" }, freshHosts: null })).toBeNull();
    expect(publishedTenantRepair({ readiness: { state: "pending", detail: "" } })).toBeNull();
    expect(publishedTenantRepair({ readiness: null })).toBeNull();
  });

  it("missingStorefrontHosts never reports a myshopify host or junk as missing", () => {
    expect(missingStorefrontHosts(null, ["demo.myshopify.com", "*.evil.example", "https://x.example/path", ""])).toEqual([]);
    expect(missingStorefrontHosts("a.example", null)).toEqual([]);
  });
});

describe("createRepairGate", () => {
  it("one repair per shop at a time, then a cooldown", () => {
    let now = 0;
    const gate = createRepairGate({ cooldownMs: 600_000, now: () => now });
    expect(gate.tryStart("a")).toBe(true);
    expect(gate.tryStart("a")).toBe(false); // running
    expect(gate.tryStart("b")).toBe(true); // another shop is independent
    gate.finish("a");
    now += 599_999;
    expect(gate.tryStart("a")).toBe(false); // cooling down
    now += 1;
    expect(gate.tryStart("a")).toBe(true);
  });
});

describe("checkPublishedTenant (afterAuth / Home / webhook path)", () => {
  const deps = (over: Partial<Parameters<typeof checkPublishedTenant>[1]> = {}) => {
    const repaired: Array<[string, RepairDecision]> = [];
    return {
      repaired,
      deps: {
        readReadiness: async () => ready,
        readFreshHosts: async () => [] as string[],
        repair: (shop: string, decision: RepairDecision) => { repaired.push([shop, decision]); },
        ...over,
      },
    };
  };

  it("an orphaned tenant is repaired", async () => {
    const t = deps({ readReadiness: async () => runtimeReadiness("t-1", { ok: false, error: "tenant integration unavailable" }) });
    expect(await checkPublishedTenant(row, t.deps)).toMatchObject({ reason: "orphaned" });
    expect(t.repaired).toEqual([["demo.myshopify.com", expect.objectContaining({ reason: "orphaned" })]]);
  });

  it("a custom domain connected after install is repaired", async () => {
    const t = deps({ readFreshHosts: async () => ["www.brand.example"] });
    expect(await checkPublishedTenant(row, t.deps)).toMatchObject({ reason: "domains" });
    expect(t.repaired).toHaveLength(1);
  });

  it("failing reads are unknown — never a repair, never a throw", async () => {
    const t = deps({
      readReadiness: async () => { throw new Error("mcp down"); },
      readFreshHosts: async () => { throw new Error("Shopify Admin 503"); },
    });
    expect(await checkPublishedTenant(row, t.deps)).toBeNull();
    expect(t.repaired).toEqual([]);
  });

  it("a live tenant whose domains are covered is left alone", async () => {
    const t = deps({ readFreshHosts: async () => ["www.brand.example"] });
    expect(await checkPublishedTenant({ ...row, customDomain: "www.brand.example" }, t.deps)).toBeNull();
    expect(t.repaired).toEqual([]);
  });
});

describe("wiring (source pins)", () => {
  const root = join(__dirname, "..");
  const server = readFileSync(join(root, "app/bmai.server.ts"), "utf8");
  const home = readFileSync(join(root, "app/routes/app._index.tsx"), "utf8");
  const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");

  it("afterAuth checks a live tenant in the background instead of returning blind", () => {
    const afterAuth = server.slice(server.indexOf("export async function onAfterAuth"), server.indexOf("export async function refreshStorefrontDomains"));
    expect(afterAuth).toMatch(/void checkPublishedTenant\(/);
    expect(afterAuth).toMatch(/customDomain: true/);
  });

  it("repairs go through the per-shop gate", () => {
    expect(server).toMatch(/repairGate\.tryStart\(shop\)/);
    expect(server).toMatch(/repairGate\.finish\(shop\)/);
  });

  it("Home repairs an orphan it reads", () => {
    expect(home).toMatch(/publishedTenantRepair\(\{ readiness: runtime/);
    expect(home).toMatch(/repairTenantInBackground\(shop, repair\)/);
  });

  it("the domains webhook is subscribed and routed", () => {
    expect(toml).toMatch(/topics = \[ "domains\/create", "domains\/update", "domains\/destroy" \]\nuri = "https:\/\/store\.busymate\.ai\/webhooks\/domains"/);
    const route = readFileSync(join(root, "app/routes/webhooks.domains.tsx"), "utf8");
    // 0.1.15: HMAC-verified WITHOUT the session-refreshing authenticate.webhook
    // (a dead session must never turn a domain change into a 500 — Shopify would
    // delete the subscription); the refresh itself resolves the token in the background.
    expect(route).toMatch(/authenticateWebhookWithoutSession\(request\)/);
    expect(route).not.toMatch(/authenticate\.webhook\(/);
    expect(route).toMatch(/void refreshStorefrontDomains\(shop\)/);
  });
});
