import { describe, expect, it, vi } from "vitest";
import {
  hostedWebFor,
  probePasswordProtection,
  readPasswordProtectionAdmin,
  storefrontIsPublic,
} from "../app/lib/storefrontPassword";
import { publishArgs } from "../app/lib/mgmtArgs";
import { publishOptionsFor } from "../app/lib/kbTrain";
import { publishedTenantRepair } from "../app/lib/tenantRepair";
import { publishedHostedWeb } from "../app/lib/runtimeReadiness";
import { runProvisionLifecycle, type ProvisionDeps } from "../app/lib/provision";

// busymate-ai-src#2704 (Shopify review S4) — a password-protected storefront gets
// NO public assistant page (hosted_web:false); only the storefront widget.

const SHOP = "acme.myshopify.com";
const res = (status: number, init: { location?: string; body?: string } = {}) =>
  new Response(init.body ?? "", { status, headers: init.location ? { location: init.location } : {} });

describe("readPasswordProtectionAdmin", () => {
  it("reads Shopify's own flag", async () => {
    expect(await readPasswordProtectionAdmin(async () => ({ onlineStore: { passwordProtection: { enabled: true } } }))).toBe(true);
    expect(await readPasswordProtectionAdmin(async () => ({ onlineStore: { passwordProtection: { enabled: false } } }))).toBe(false);
  });
  it("is unknown on an error, a missing field or no client", async () => {
    expect(await readPasswordProtectionAdmin(async () => { throw new Error("ACCESS_DENIED"); })).toBeNull();
    expect(await readPasswordProtectionAdmin(async () => ({}))).toBeNull();
    expect(await readPasswordProtectionAdmin(null)).toBeNull();
  });
});

describe("probePasswordProtection", () => {
  it("a redirect to /password is protected", async () => {
    expect(await probePasswordProtection(SHOP, async () => res(302, { location: `https://${SHOP}/password` }))).toBe(true);
    expect(await probePasswordProtection(SHOP, async () => res(302, { location: "/password" }))).toBe(true);
  });
  it("a 200 storefront is public unless it is the password form", async () => {
    expect(await probePasswordProtection(SHOP, async () => res(200, { body: "<html><main>Products</main></html>" }))).toBe(false);
    expect(await probePasswordProtection(SHOP, async () => res(200, { body: '<form method="post" action="/password" id="login_form">' }))).toBe(true);
  });
  it("any other answer is unknown", async () => {
    expect(await probePasswordProtection(SHOP, async () => res(301, { location: "https://www.acme.com/" }))).toBeNull();
    expect(await probePasswordProtection(SHOP, async () => res(503))).toBeNull();
    expect(await probePasswordProtection(SHOP, async () => { throw new Error("timeout"); })).toBeNull();
  });
});

describe("storefrontIsPublic + hostedWebFor", () => {
  it("Admin answers first; the storefront probe only when Admin cannot", async () => {
    const probe = vi.fn(async () => res(200, { body: "<html></html>" }));
    expect(await storefrontIsPublic(SHOP, async () => ({ onlineStore: { passwordProtection: { enabled: true } } }), probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(await storefrontIsPublic(SHOP, async () => { throw new Error("denied"); }, probe)).toBe(true);
    expect(await storefrontIsPublic(SHOP, null, async () => res(500))).toBeNull();
  });
  it("fails closed: only a definitely public store gets a public page", () => {
    expect(hostedWebFor(true)).toBe(true);
    expect(hostedWebFor(false)).toBe(false);
    expect(hostedWebFor(null)).toBe(false);
  });
});

describe("hosted_web on the wire", () => {
  it("publishArgs sends hosted_web only when stated", () => {
    expect(publishArgs(null, "t", { hostedWeb: false }).hosted_web).toBe(false);
    expect(publishArgs(null, "t", { hostedWeb: true }).hosted_web).toBe(true);
    expect("hosted_web" in publishArgs(null, "t", {})).toBe(false);
  });
  it("publishOptionsFor carries it through", () => {
    expect(publishOptionsFor(null, { launchOrigins: [], embedOrigins: [], hostedWeb: false }).hostedWeb).toBe(false);
    expect("hostedWeb" in publishOptionsFor(null, { launchOrigins: [], embedOrigins: [] })).toBe(false);
  });
  it("the provisioning publish states hosted_web from the storefront", async () => {
    for (const [isPublic, expected] of [[false, false], [true, true], [null, false]] as const) {
      const seen: Record<string, Record<string, unknown>> = {};
      const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
        seen[name] = args;
        if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
        if (name === "publish_tenant_runtime") return { ok: true, data: { revision: 1 } };
        return { ok: true };
      });
      const deps: ProvisionDeps = {
        call: call as unknown as ProvisionDeps["call"],
        getTenant: async () => null,
        saveTenant: async () => {},
        connectorEndpoint: () => "https://store.busymate.ai/mcp",
        embedOrigin: "https://busymate.ai",
        signProof: () => ({ partner: "shopify", shop: SHOP, proof: "p", ts: 1 }),
        delegationReady: false,
        storefrontPublic: async () => isPublic,
      };
      await runProvisionLifecycle({ shop: SHOP }, deps);
      expect(seen.publish_tenant_runtime.hosted_web).toBe(expected);
    }
  });
});

describe("hosted_web drift repair", () => {
  const ready = (hostedWeb?: boolean) => ({ state: "ready" as const, detail: "", ...(hostedWeb === undefined ? {} : { hostedWeb }) });
  it("re-publishes when the password state and the published page disagree", () => {
    expect(publishedTenantRepair({ readiness: ready(true), wantedHostedWeb: false })?.reason).toBe("hosted_web");
    expect(publishedTenantRepair({ readiness: ready(false), wantedHostedWeb: true })?.reason).toBe("hosted_web");
  });
  it("never on agreement, an unknown password state or an unknown published page", () => {
    expect(publishedTenantRepair({ readiness: ready(false), wantedHostedWeb: false })).toBeNull();
    expect(publishedTenantRepair({ readiness: ready(true), wantedHostedWeb: null })).toBeNull();
    expect(publishedTenantRepair({ readiness: ready(), wantedHostedWeb: false })).toBeNull();
  });
  it("reads the published page from get_tenant_integration", () => {
    expect(publishedHostedWeb({ ok: true, data: { publication: { integration_config: { channels: { hosted_web: false } } } } })).toBe(false);
    expect(publishedHostedWeb({ ok: true, data: {} })).toBeUndefined();
  });
});

describe("reconcile sweep", () => {
  it("re-provisions a live tenant whose public page disagrees with the storefront", async () => {
    const { planReconcile } = await import("../app/lib/reconcile");
    const row = { shop: SHOP, provisionState: "published", bmaiTenantId: "t", tenantUnreachableAt: null };
    const readiness = { state: "ready" as const, detail: "", hostedWeb: true };
    expect(planReconcile(row, { readiness, frameable: true, wantedHostedWeb: false })).toMatchObject({ verdict: "hosted-web-drift", action: "reprovision" });
    expect(planReconcile(row, { readiness, frameable: true, wantedHostedWeb: true }).verdict).toBe("live");
    expect(planReconcile(row, { readiness, frameable: true, wantedHostedWeb: null }).verdict).toBe("live");
  });
});
