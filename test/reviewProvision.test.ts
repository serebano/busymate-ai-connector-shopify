import { describe, expect, it } from "vitest";
import { runProvisionLifecycle, runtimeOrigins, type ProvisionDeps, type TenantPatch } from "../app/lib/provision";

/** Regression for the Sep 11 review: connector rejection must never look published. */
describe("fresh install with delegated customer tools", () => {
  it.each([false, true])("preserves publish preflight when connector denied=%s", async (denyConnector) => {
    let connector = false;
    let provider = false;
    const states: TenantPatch[] = [];
    const call: ProvisionDeps["call"] = async <T>(name: string, args: Record<string, unknown>) => {
      let data: unknown;
      if (name === "provision_partner_tenant") data = { tenant_id: "tenant" };
      if (name === "upsert_tenant_support_connector") {
        if (denyConnector || typeof args.description !== "string" || !args.description.trim()) {
          return { ok: false, error: "description is required" };
        }
        expect(args.delegation_mode).toBe("signed_actor_token");
        expect((args.tool_access as Record<string, string>).get_order_status).toBe("identified");
        expect((args.tool_access as Record<string, string>).cancel_order).toBe("delegated");
        expect((args.tool_access as Record<string, string>).create_refund).toBeUndefined();
        expect((args.tool_access as Record<string, string>).start_return).toBeUndefined();
        connector = true;
        data = { id: "connector" };
      }
      if (name === "upsert_tenant_identity_provider") {
        provider = true;
        data = { provider: { id: "provider" } };
      }
      if (name === "publish_tenant_runtime") {
        if (provider && !connector) return { ok: false, error: "preflight unmet: delegated-account-tool" };
        data = { revision: 1, connector_ids: ["connector"], identity_provider_ids: ["provider"] };
      }
      return { ok: true, data: data as T };
    };
    const out = await runProvisionLifecycle({ shop: "review.myshopify.com" }, {
      call,
      getTenant: async () => null,
      saveTenant: async (_shop, patch) => { states.push(patch); },
      connectorEndpoint: () => "https://store.busymate.ai/mcp",
      embedOrigin: "https://busymate.ai",
      signProof: () => ({ partner: "shopify", shop: "review.myshopify.com", proof: "fixture", ts: 1 }),
      delegationReady: true,
      launchIdentity: {
        issuer: "https://store.busymate.ai", jwksUri: "https://store.busymate.ai/.well-known/jwks.json",
        identityEndpointUrl: "https://store.busymate.ai/identity", audience: "bmai-support-launch",
        tenantClaim: "shop", maxTokenAgeSeconds: 120,
      },
    });
    expect(out.ok).toBe(!denyConnector);
    expect(states.at(-1)?.provisionState).toBe(denyConnector ? "error" : "published");
    if (denyConnector) {
      expect(out.error).toContain("delegated-account-tool");
      expect(out.warnings).toContain("upsert_tenant_support_connector: description is required");
      expect(states.some(s => s.provisionState === "published")).toBe(false);
    } else {
      expect(out.connectorId).toBe("connector");
      expect(out.identityProviderId).toBe("provider");
      expect(out.warnings).toEqual([]);
      expect(states.at(-1)?.provisionWarning).toBeNull();
    }
  });
});


describe("Shopify theme editor ancestor chain", () => {
  it("allows the store and both Shopify editor ancestors without widening launch origins", () => {
    const origins = runtimeOrigins("review.myshopify.com", "shop-review", "shop.example.com");
    expect(origins.embedOrigins).toEqual([
      "https://review.myshopify.com", "https://shop.example.com",
      "https://admin.shopify.com", "https://online-store-web.shopifyapps.com",
    ]);
    expect(origins.launchOrigins).toEqual(["https://shop-review.busymate.ai"]);
    expect(origins.embedOrigins.some(origin => origin.includes("*"))).toBe(false);
  });
});
