import { describe, expect, it, vi } from "vitest";
import {
  runProvisionLifecycle,
  authNeedsProvision,
  provisionOnInstall,
  publishedRuntimeGaps,
  CONNECTOR_POLICIES,
  servingHost,
  type ProvisionDeps,
  type TenantPatch,
} from "../app/lib/provision";
import type { IdentityProviderRegistration } from "../app/lib/mgmtArgs";
import type { PartnerProof } from "../app/lib/partnerProof";

// The tenant-provisioning SEAM — exercised with the Shopify session + bmai MCP
// calls fully mocked (no Partner app, no real shop, no control plane). Asserts the
// proof-of-shop lifecycle order, proof threading, best-effort vs load-bearing
// steps, fail-closed behaviour, and the final persisted state.

const STUB_PROOF: PartnerProof = { partner: "shopify", shop: "acme.myshopify.com", proof: "deadbeef", ts: 1787900000000 };

/** The launch-JWT provider this host publishes (app/lib/identity.ts launchIdentityRegistration). */
const LAUNCH: IdentityProviderRegistration = {
  issuer: "https://store.busymate.ai",
  jwksUri: "https://store.busymate.ai/.well-known/jwks.json",
  identityEndpointUrl: "https://store.busymate.ai/identity",
  audience: "bmai-support-launch",
  tenantClaim: "shop",
  maxTokenAgeSeconds: 120,
};

function makeDeps(
  call: ProvisionDeps["call"],
  opts: { proof?: PartnerProof | null; delegationReady?: boolean; launchIdentity?: IdentityProviderRegistration | null } = {},
): { deps: ProvisionDeps; states: TenantPatch[] } {
  const states: TenantPatch[] = [];
  const deps: ProvisionDeps = {
    call,
    getTenant: async () => ({ bmaiTenantId: null, customDomain: null }),
    // Omitted ⇒ the launch signing key is NOT configured ⇒ no provider step; the
    // #2132 identity-provider cases opt in explicitly with `launchIdentity: LAUNCH`.
    launchIdentity: opts.launchIdentity ?? null,
    saveTenant: async (_shop, patch) => {
      states.push(patch);
    },
    connectorEndpoint: () => "https://shopify.busymate.ai/mcp",
    embedOrigin: "https://busymate.ai",
    signProof: () => (opts.proof === undefined ? STUB_PROOF : opts.proof),
    delegationReady: opts.delegationReady ?? false,
  };
  return { deps, states };
}

const session = { shop: "acme.myshopify.com", email: "owner@acme.com", accessToken: "off_tok" };

describe("tenant provisioning lifecycle (seam)", () => {
  it.each([true, false])("reuses registered IDs only for the same tenant: %s", async sameTenant => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
      seen[name] = args;
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: sameTenant ? "old" : "new" } };
      // Missing returned IDs exercise safe fallback as well as update arguments.
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: LAUNCH });
    deps.getTenant = async () => ({ bmaiTenantId: "old", connectorId: "old-connector", identityProviderId: "old-provider" });
    const out = await runProvisionLifecycle(session, deps);
    expect(seen.upsert_tenant_support_connector.connector_id).toBe(sameTenant ? "old-connector" : undefined);
    expect(seen.upsert_tenant_identity_provider.provider_id).toBe(sameTenant ? "old-provider" : undefined);
    expect(out.connectorId).toBe(sameTenant ? "old-connector" : null);
    expect(out.identityProviderId).toBe(sameTenant ? "old-provider" : null);
  });
  it("runs the full lifecycle in order and publishes on success", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_123" } };
      if (name === "upsert_tenant_support_connector") return { ok: true, data: { id: "c_9" } };
      if (name === "upsert_tenant_identity_provider") return { ok: true, data: { provider: { id: "p_7" } } };
      // The platform echoes what the published revision ASSIGNED (#2132).
      if (name === "publish_tenant_runtime") return { ok: true, data: { revision: 1, connector_ids: ["c_9"], identity_provider_ids: ["p_7"] } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: LAUNCH });

    const out = await runProvisionLifecycle(session, deps);

    expect(out.ok).toBe(true);
    expect(out.tenantId).toBe("t_123");
    expect(out.connectorId).toBe("c_9");
    expect(out.identityProviderId).toBe("p_7");
    // Exact ordered contract with the bmai MCP tenant tools (NO operator-only
    // set_tenant_domain — the tenant serves at the derived <slug>.busymate.ai lane).
    // The identity provider (#2132 FAIL A) registers right after the connector, so
    // ONE publish can assign both.
    expect(out.calls).toEqual([
      "provision_partner_tenant",
      "set_tenant_branding",
      "add_tenant_embed_origin",
      "upsert_tenant_support_connector",
      "upsert_tenant_identity_provider",
      "publish_tenant_runtime",
    ]);
    // add_tenant_admin is NOT called (needs a bmai user_id a Shopify install lacks).
    expect(out.calls).not.toContain("add_tenant_admin");
    expect(out.warnings).toEqual([]);
    // Final persisted state is "published", with both registrations live (no warning).
    expect(states.at(-1)?.provisionState).toBe("published");
    expect(states.at(-1)?.bmaiTenantId).toBe("t_123");
    expect(states.at(-1)?.identityProviderId).toBe("p_7");
    expect(states.at(-1)?.provisionWarning).toBeNull();
  });

  it("threads the proof-of-shop into provision + embed-origin, and never sends set_tenant_domain", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"]);
    const out = await runProvisionLifecycle(session, deps);

    expect(out.calls).not.toContain("set_tenant_domain");
    // provision carries partner/shop/proof/ts + slug
    expect(seen["provision_partner_tenant"]).toMatchObject({ partner: "shopify", shop: session.shop, proof: "deadbeef", ts: STUB_PROOF.ts });
    expect(seen["provision_partner_tenant"].slug).toMatch(/^shop-/);
    // embed-origin uses the PROOF path (no tenant_id needed) + the storefront origin + confirm
    expect(seen["add_tenant_embed_origin"]).toMatchObject({ proof: "deadbeef", confirm: true });
    expect(seen["add_tenant_embed_origin"].origins).toContain(`https://${session.shop}`);
    // publish sends the derived serving host as a launch origin + confirm
    expect(seen["publish_tenant_runtime"]).toMatchObject({ tenant_id: "t_1", confirm: true });
    expect(seen["publish_tenant_runtime"].launch_origins).toContain(servingHost("shop-acme"));
    // #1982 security follow-up #5 — LEAST PRIVILEGE: every tenant-management call
    // carries proof-of-shop so it authorizes via the proof arm, NOT the platform-
    // operator role (which the provisioner no longer needs / holds).
    for (const mgmt of ["set_tenant_branding", "upsert_tenant_support_connector", "publish_tenant_runtime"]) {
      expect(seen[mgmt]).toMatchObject({ partner: "shopify", shop: session.shop, proof: "deadbeef", ts: STUB_PROOF.ts });
    }
  });

  it("registers the connector read-only (public + identified; delegated writes deferred)", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"]);
    await runProvisionLifecycle(session, deps);

    const connectorCall = call.mock.calls.find((c) => c[0] === "upsert_tenant_support_connector");
    expect(connectorCall).toBeDefined();
    const args = connectorCall![1] as unknown as {
      auth_mode: string;
      delegation_mode: string;
      tool_access: Record<string, string>;
    };
    // Unauthenticated server access; no delegation until the actor verifier ships.
    expect(args.auth_mode).toBe("none");
    expect(args.delegation_mode).toBe("none");
    // Read tiers registered: public reads + identified customer reads.
    expect(args.tool_access.search_products).toBe("public");
    expect(args.tool_access.get_order_status).toBe("identified");
    // Delegated WRITE tools are NOT registered yet (would be refused w/o verifier).
    expect(args.tool_access.create_refund).toBeUndefined();
    expect(args.tool_access.start_return).toBeUndefined();
  });

  it("#2482 registers a non-empty title AND description (an empty description broke the shared registry export)", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"]);
    await runProvisionLifecycle(session, deps);

    const connectorCall = call.mock.calls.find((c) => c[0] === "upsert_tenant_support_connector");
    expect(connectorCall).toBeDefined();
    const args = connectorCall![1] as unknown as { title?: unknown; description?: unknown };
    expect(typeof args.title).toBe("string");
    expect((args.title as string).trim().length).toBeGreaterThan(0);
    expect(typeof args.description).toBe("string");
    expect((args.description as string).trim().length).toBeGreaterThan(0);
  });

  it("flips to signed_actor_token + registers the delegated writes when the verifier is ready", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"], { delegationReady: true });
    await runProvisionLifecycle(session, deps);

    const connectorCall = call.mock.calls.find((c) => c[0] === "upsert_tenant_support_connector");
    const args = connectorCall![1] as unknown as {
      auth_mode: string;
      delegation_mode: string;
      tool_access: Record<string, string>;
    };
    // Actor verifier ready → per-user delegation via the signed actor token.
    expect(args.auth_mode).toBe("none");
    expect(args.delegation_mode).toBe("signed_actor_token");
    // Read tiers still present…
    expect(args.tool_access.search_products).toBe("public");
    expect(args.tool_access.get_order_status).toBe("identified");
    // …and EVERY delegated write tool is now registered as delegated.
    for (const t of CONNECTOR_POLICIES.delegated_tools) {
      expect(args.tool_access[t]).toBe("delegated");
    }
    // …each confirm-gated on the platform (#2132: the "cancel my order" confirmation
    // park). Registered in lockstep with the delegated tier.
    expect((args as { confirm_tools?: string[] }).confirm_tools).toEqual([...CONNECTOR_POLICIES.confirm_tools]);
  });

  it("read-only mode registers NO confirm_tools (nothing delegated to gate)", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"], { delegationReady: false });
    await runProvisionLifecycle(session, deps);
    const args = call.mock.calls.find((c) => c[0] === "upsert_tenant_support_connector")![1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("confirm_tools");
  });

  it("never calls add_tenant_admin (a Shopify install has no bmai user_id)", async () => {
    const call = vi.fn(async (name: string) =>
      name === "provision_partner_tenant" ? { ok: true, data: { tenant_id: "t_1" } } : { ok: true },
    );
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"]);
    const out = await runProvisionLifecycle({ shop: "x.myshopify.com", email: "m@x.com" }, deps);
    expect(out.calls).not.toContain("add_tenant_admin");
  });

  it("BEST-EFFORT: a denied set_tenant_branding warns but still publishes", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "set_tenant_branding") return { ok: false, error: "tenant-admin required" };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    const out = await runProvisionLifecycle(session, deps);

    expect(out.ok).toBe(true); // publish still happened
    expect(out.warnings.some((w) => w.startsWith("set_tenant_branding:"))).toBe(true);
    expect(states.at(-1)?.provisionState).toBe("published");
  });

  it("FAILS CLOSED: a failed provision records error state and never publishes", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: false, error: "provision_partner_tenant denied" };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);

    const out = await runProvisionLifecycle(session, deps);

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/denied/);
    // No branding, nothing after the failed provision.
    expect(out.calls).toEqual(["provision_partner_tenant"]);
    expect(states.at(-1)?.provisionState).toBe("error");
  });

  it("FAILS CLOSED: a failed publish records error state (tenant created, not live)", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "publish_tenant_runtime") return { ok: false, error: "preflight unmet" };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    const out = await runProvisionLifecycle(session, deps);

    expect(out.ok).toBe(false);
    expect(out.tenantId).toBe("t_1"); // created…
    expect(states.at(-1)?.provisionState).toBe("error"); // …but not live
    expect(states.at(-1)?.provisionError).toMatch(/publish_tenant_runtime/);
  });

  // --- provisionOnInstall: the afterAuth guard that must NEVER throw ---
  // (App Store review 2.1.1/2.1.3: an afterAuth throw becomes a bare embedded-app
  // 500. runProvisionLifecycle records error state for a failed MCP step but still
  // THROWS at its Prisma write boundary — the guard is what makes afterAuth safe.)

  it("provisionOnInstall NEVER throws — a Prisma write race records error state instead of a 500", async () => {
    // saveTenant throws on the FIRST write (the initial `provisioning` state), like
    // a P2002 unique-constraint race from Shopify's App-Bridge double install bounce.
    let writes = 0;
    const states: TenantPatch[] = [];
    const call = vi.fn(async () => ({ ok: true }));
    const deps: ProvisionDeps = {
      call: call as unknown as ProvisionDeps["call"],
      getTenant: async () => null,
      saveTenant: async (_shop, patch) => {
        writes += 1;
        if (writes === 1) throw new Error("Unique constraint failed on the fields: (`shop`)");
        states.push(patch);
      },
      connectorEndpoint: () => "https://store.busymate.ai/mcp",
      embedOrigin: "https://busymate.ai",
      signProof: () => STUB_PROOF,
      delegationReady: false,
    };

    // Must RESOLVE (never reject) — that is the whole contract afterAuth relies on.
    await expect(provisionOnInstall(session, deps)).resolves.toMatchObject({ ok: false });
    // The failure is recorded as an operational error state (surfaced in the app UI).
    expect(states.at(-1)?.provisionState).toBe("error");
    expect(states.at(-1)?.provisionError).toMatch(/Unique constraint/);
  });

  it("provisionOnInstall swallows a TOTAL DB outage (even the error-record write throws)", async () => {
    const deps: ProvisionDeps = {
      call: (async () => ({ ok: true })) as unknown as ProvisionDeps["call"],
      getTenant: async () => {
        throw new Error("DB down");
      },
      saveTenant: async () => {
        throw new Error("DB down");
      },
      connectorEndpoint: () => "https://store.busymate.ai/mcp",
      embedOrigin: "https://busymate.ai",
      signProof: () => STUB_PROOF,
      delegationReady: false,
    };
    // Nothing can be persisted, yet the guard must still resolve — afterAuth cannot
    // be allowed to 500 the embedded app even when the DB is entirely unreachable.
    await expect(provisionOnInstall(session, deps)).resolves.toMatchObject({ ok: false });
  });

  it("provisionOnInstall does NOT stomp a racing success — a concurrent publish wins", async () => {
    // The initial write throws (lost the race), but by the time we re-read, the
    // racing install has already provisioned the tenant → keep the good state.
    const call = vi.fn(async () => ({ ok: true }));
    const deps: ProvisionDeps = {
      call: call as unknown as ProvisionDeps["call"],
      getTenant: async () => ({ bmaiTenantId: "t_win", customDomain: null }),
      saveTenant: async () => {
        throw new Error("Unique constraint failed on the fields: (`shop`)");
      },
      connectorEndpoint: () => "https://store.busymate.ai/mcp",
      embedOrigin: "https://busymate.ai",
      signProof: () => STUB_PROOF,
      delegationReady: false,
    };
    const out = await provisionOnInstall(session, deps);
    expect(out.ok).toBe(true);
    expect(out.tenantId).toBe("t_win");
  });

  it("provisionOnInstall passes a normal successful lifecycle straight through", async () => {
    const call = vi.fn(async (name: string) =>
      name === "provision_partner_tenant" ? { ok: true, data: { tenant_id: "t_ok" } } : { ok: true },
    );
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    const out = await provisionOnInstall(session, deps);
    expect(out.ok).toBe(true);
    expect(out.tenantId).toBe("t_ok");
    expect(states.at(-1)?.provisionState).toBe("published");
  });

  it("PRESERVES a previously-captured connectorId when an idempotent re-upsert returns no id", async () => {
    // Re-auth path: the tenant already has a connector; the best-effort re-upsert
    // returns ok but WITHOUT re-echoing the id. The final state must keep the id,
    // not null it (which regressed the app's "connector registered" display).
    const states: TenantPatch[] = [];
    const call = vi.fn(async (name: string) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "upsert_tenant_support_connector") return { ok: true }; // no id echoed
      return { ok: true };
    });
    const deps: ProvisionDeps = {
      call: call as unknown as ProvisionDeps["call"],
      getTenant: async () => ({ bmaiTenantId: "t_1", customDomain: null, connectorId: "c_existing" }),
      saveTenant: async (_shop, patch) => {
        states.push(patch);
      },
      connectorEndpoint: () => "https://store.busymate.ai/mcp",
      embedOrigin: "https://busymate.ai",
      signProof: () => STUB_PROOF,
      delegationReady: false,
    };
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(out.connectorId).toBe("c_existing");
    expect(states.at(-1)?.provisionState).toBe("published");
    expect(states.at(-1)?.connectorId).toBe("c_existing");
  });

  it("still provisions with NO proof (operator path) — proofArgs are simply omitted", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"], { proof: null });
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(seen["provision_partner_tenant"].proof).toBeUndefined();
    expect(seen["provision_partner_tenant"]).toMatchObject({ partner: "shopify", shop: session.shop });
  });
});

// --- Grounded knowledge at install + reinstall (#2110) ---------------------
// The lifecycle trains the tenant on the store (products/policies/pages) in the
// SAME publish that takes it live: provision → branding → embed origin →
// connector → buildKnowledge → publish(knowledge_sources). A training failure
// is persisted + surfaced (kbError) but never blocks the tenant going live.

const KNOWLEDGE = {
  sources: [
    { key: "shopify:policies", label: "Store policies", kind: "reference" as const, content: "Refunds within 30 days." },
    { key: "shopify:products", label: "Product catalog", kind: "fact" as const, content: "Board — 99.00 USD" },
  ],
  counts: { products: 1, policies: 1, pages: 0 },
  fetched: { products: 1, policies: 1, pages: 0 },
  totalChars: 40,
  truncated: false,
};

describe("lifecycle — grounded knowledge + reinstall", () => {
  it("builds the knowledge AFTER the connector and BEFORE publish, and publishes it as knowledge_sources", async () => {
    const order: string[] = [];
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      order.push(name);
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1", created: true } };
      if (name === "upsert_tenant_support_connector") return { ok: true, data: { id: "c_1" } };
      if (name === "publish_tenant_runtime") return { ok: true, data: { revision: 3, knowledge_source_ids: ["k1", "k2"] } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    deps.buildKnowledge = async (shop) => {
      order.push(`buildKnowledge:${shop}`);
      return KNOWLEDGE;
    };
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(order).toEqual([
      "provision_partner_tenant",
      "set_tenant_branding",
      "add_tenant_embed_origin",
      "upsert_tenant_support_connector",
      "buildKnowledge:acme.myshopify.com",
      "publish_tenant_runtime",
    ]);
    // ONE publish, carrying origins + the compressed knowledge (never kb_snapshot).
    expect(call.mock.calls.filter((c) => c[0] === "publish_tenant_runtime")).toHaveLength(1);
    expect(seen["publish_tenant_runtime"].knowledge_sources).toEqual(KNOWLEDGE.sources);
    expect(seen["publish_tenant_runtime"]).not.toHaveProperty("kb_snapshot");
    expect(seen["publish_tenant_runtime"].launch_origins).toContain(servingHost("shop-acme"));
    // Training state persisted with the published state.
    const last = states.at(-1)!;
    expect(last.provisionState).toBe("published");
    expect(last.kbProducts).toBe(1);
    expect(last.kbPolicies).toBe(1);
    expect(last.kbPages).toBe(0);
    expect(last.kbTrainedAt).toBeInstanceOf(Date);
    expect(last.kbError).toBeNull();
    expect(out.training).toMatchObject({ ok: true, counts: KNOWLEDGE.counts });
    expect(out.reactivated).toBe(false);
  });

  it("a knowledge build failure is persisted as kbError + warned, and the tenant STILL goes live without knowledge", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    deps.buildKnowledge = async () => {
      throw new Error("Shopify Admin 403");
    };
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(seen["publish_tenant_runtime"]).not.toHaveProperty("knowledge_sources");
    expect(out.warnings.some((w) => /knowledge: Shopify Admin 403/.test(w))).toBe(true);
    const last = states.at(-1)!;
    expect(last.provisionState).toBe("published");
    expect(last.kbError).toMatch(/Shopify Admin 403/);
    expect(last).not.toHaveProperty("kbTrainedAt");
    expect(out.training).toMatchObject({ ok: false, error: expect.stringMatching(/403/) });
  });

  it("a knowledge_sources rejection at the edge re-publishes WITHOUT knowledge (tenant live) and persists the rejection", async () => {
    const publishes: Record<string, unknown>[] = [];
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "publish_tenant_runtime") {
        publishes.push(args ?? {});
        if (args && "knowledge_sources" in args) return { ok: false, error: "knowledge_sources total content exceeds 40,000 characters (40001)" };
        return { ok: true, data: { revision: 4 } };
      }
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    deps.buildKnowledge = async () => KNOWLEDGE;
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(publishes).toHaveLength(2);
    expect(publishes[0]).toHaveProperty("knowledge_sources");
    expect(publishes[1]).not.toHaveProperty("knowledge_sources");
    expect(states.at(-1)!.provisionState).toBe("published");
    expect(states.at(-1)!.kbError).toMatch(/exceeds 40,000/);
  });

  it("a NON-knowledge publish failure is NOT retried and fails closed as before", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "publish_tenant_runtime") return { ok: false, error: "proof-of-shop verification failed" };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    deps.buildKnowledge = async () => KNOWLEDGE;
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(false);
    expect(call.mock.calls.filter((c) => c[0] === "publish_tenant_runtime")).toHaveLength(1);
    expect(states.at(-1)!.provisionState).toBe("error");
  });

  it("REINSTALL: provision_partner_tenant reactivated:true → re-published, state published (Home 'Live'), reactivated reported", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_old", created: false, reactivated: true } };
      return { ok: true };
    });
    const states: TenantPatch[] = [];
    const deps: ProvisionDeps = {
      call: call as unknown as ProvisionDeps["call"],
      // The app row is still there from before the uninstall (suspended).
      getTenant: async () => ({ bmaiTenantId: "t_old", customDomain: null, connectorId: "c_old", provisionState: "suspended" }),
      saveTenant: async (_shop, patch) => {
        states.push(patch);
      },
      connectorEndpoint: () => "https://store.busymate.ai/mcp",
      embedOrigin: "https://busymate.ai",
      signProof: () => STUB_PROOF,
      delegationReady: false,
      buildKnowledge: async () => KNOWLEDGE,
    };
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(out.reactivated).toBe(true);
    expect(out.tenantId).toBe("t_old");
    expect(out.calls.at(-1)).toBe("publish_tenant_runtime");
    expect(seen["publish_tenant_runtime"]).toMatchObject({ tenant_id: "t_old", confirm: true });
    expect(seen["publish_tenant_runtime"].knowledge_sources).toEqual(KNOWLEDGE.sources);
    expect(states.at(-1)).toMatchObject({ provisionState: "published", bmaiTenantId: "t_old", provisionError: null, kbProducts: 1 });
    // #3718 — a successful publish clears the meter's unreachable mark, so a
    // repaired tenant is not re-repaired every 10 min until the hourly meter run.
    expect(states.at(-1)).toHaveProperty("tenantUnreachableAt", null);
  });

  it("#2132 C — REINSTALL / re-run of an EXISTING tenant NEVER re-seeds the default branding (the merchant's saved names survive)", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_old", created: false, reactivated: true } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"]);
    deps.getTenant = async () => ({ bmaiTenantId: "t_old", customDomain: null, connectorId: "c_old", provisionState: "suspended" });
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(out.calls).not.toContain("set_tenant_branding");
    // …and the same for a plain re-run (Connector "Retry"/re-auth) of a live tenant.
    const rerun = vi.fn(async (name: string) => (name === "provision_partner_tenant" ? { ok: true, data: { tenant_id: "t_live", created: false } } : { ok: true }));
    const again = makeDeps(rerun as unknown as ProvisionDeps["call"]);
    again.deps.getTenant = async () => ({ bmaiTenantId: "t_live", customDomain: null, provisionState: "published" });
    expect((await runProvisionLifecycle(session, again.deps)).calls).not.toContain("set_tenant_branding");
  });

  it("#2132 C — a NEW tenant is seeded with the default branding (productName = shop, assistant 'your mate')", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_new", created: true } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"]);
    const out = await runProvisionLifecycle(session, deps);
    expect(out.calls).toContain("set_tenant_branding");
    expect(seen["set_tenant_branding"]).toMatchObject({ branding: { productName: session.shop, assistantName: "your mate" }, confirm: true });
  });

  it("without a buildKnowledge dep (ops verify script) the lifecycle publishes with no knowledge and records no training", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"]);
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(seen["publish_tenant_runtime"]).not.toHaveProperty("knowledge_sources");
    expect(states.at(-1)).not.toHaveProperty("kbTrainedAt");
    expect(out.training).toBeNull();
  });
});


// --- Visitor identity provider + assignment proof (#2132 FAIL A) ---------------
// support-launch trusts a launch JWT ONLY for a provider registered under the
// token's issuer AND assigned to the published revision. The lifecycle registers
// this host's issuer (idempotently) and proves the publish assigned it — a
// registered-but-unassigned connector/provider is surfaced, never "Connected".

describe("lifecycle — visitor identity provider (#2132)", () => {
  it("registers the launch-JWT issuer after the connector, threads proof + delegated_access, and binds it to the shop", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1", created: true } };
      if (name === "upsert_tenant_support_connector") return { ok: true, data: { id: "c_1" } };
      if (name === "upsert_tenant_identity_provider") return { ok: true, data: { provider: { id: "p_1" } } };
      if (name === "publish_tenant_runtime") return { ok: true, data: { revision: 2, connector_ids: ["c_1"], identity_provider_ids: ["p_1"] } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: LAUNCH, delegationReady: true });
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    const idx = (n: string) => out.calls.indexOf(n);
    expect(idx("upsert_tenant_identity_provider")).toBeGreaterThan(idx("upsert_tenant_support_connector"));
    expect(idx("upsert_tenant_identity_provider")).toBeLessThan(idx("publish_tenant_runtime"));
    expect(seen["upsert_tenant_identity_provider"]).toMatchObject({
      partner: "shopify",
      shop: "acme.myshopify.com",
      proof: "deadbeef",
      tenant_id: "t_1",
      label: "Shopify customer accounts",
      issuer: LAUNCH.issuer,
      jwks_uri: LAUNCH.jwksUri,
      audiences: ["bmai-support-launch"],
      tenant_claim: "shop",
      tenant_claim_value: "acme.myshopify.com",
      subject_claim: "sub",
      allowed_algs: ["ES256"],
      max_token_age_seconds: 120,
      identity_endpoint_url: LAUNCH.identityEndpointUrl,
      login_url: "https://acme.myshopify.com/account/login",
      account_url: "https://acme.myshopify.com/account",
      delegated_access: true,
      enabled: true,
      confirm: true,
    });
    // First run: no persisted provider → no provider_id (create).
    expect(seen["upsert_tenant_identity_provider"]).not.toHaveProperty("provider_id");
    expect(states.at(-1)?.identityProviderId).toBe("p_1");
    expect(states.at(-1)?.provisionWarning).toBeNull();
  });

  it("delegated_access mirrors the verifier readiness (read-only host → false)", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      return { ok: true };
    });
    const { deps } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: LAUNCH, delegationReady: false });
    await runProvisionLifecycle(session, deps);
    expect(seen["upsert_tenant_identity_provider"].delegated_access).toBe(false);
  });

  it("re-targets the PERSISTED provider id on a re-run (idempotent — never a second provider for one issuer)", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const call = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      seen[name] = args ?? {};
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "upsert_tenant_identity_provider") return { ok: true, data: { provider: { id: "p_existing" } } };
      if (name === "publish_tenant_runtime") return { ok: true, data: { connector_ids: ["c_old"], identity_provider_ids: ["p_existing"] } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: LAUNCH });
    deps.getTenant = async () => ({ bmaiTenantId: "t_1", customDomain: null, connectorId: "c_old", identityProviderId: "p_existing" });
    const out = await runProvisionLifecycle(session, deps);
    expect(seen["upsert_tenant_identity_provider"].provider_id).toBe("p_existing");
    expect(out.identityProviderId).toBe("p_existing");
    expect(states.at(-1)?.identityProviderId).toBe("p_existing");
  });

  it("no launch signing key (launchIdentity null) → NO provider step; shoppers stay anonymous honestly", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "publish_tenant_runtime") return { ok: true, data: { connector_ids: [] } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: null });
    const out = await runProvisionLifecycle(session, deps);
    expect(out.calls).not.toContain("upsert_tenant_identity_provider");
    expect(out.identityProviderId).toBeNull();
    expect(states.at(-1)?.identityProviderId).toBeNull();
  });

  it("a provider denial is a SOFT failure — warned, tenant still published, no id persisted", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "upsert_tenant_identity_provider") return { ok: false, error: "tenant integration administration denied" };
      if (name === "publish_tenant_runtime") return { ok: true, data: { connector_ids: [] } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: LAUNCH });
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w) => /upsert_tenant_identity_provider: .*denied/.test(w))).toBe(true);
    expect(states.at(-1)?.provisionState).toBe("published");
    expect(states.at(-1)?.identityProviderId).toBeNull();
  });

  it("FAIL-CLOSED assignment proof: a publish that does not echo the connector/provider as assigned persists provisionWarning (never silent Connected)", async () => {
    const call = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "provision_partner_tenant") return { ok: true, data: { tenant_id: "t_1" } };
      if (name === "upsert_tenant_support_connector") return { ok: true, data: { id: "c_1" } };
      if (name === "upsert_tenant_identity_provider") return { ok: true, data: { provider: { id: "p_1" } } };
      // The pre-fix platform: registered rows never assigned (connector_ids: []) —
      // exactly the #2132 FAIL A state (assigned_to_published_revision:false).
      if (name === "publish_tenant_runtime") return { ok: true, data: { revision: 5, connector_ids: [], identity_provider_ids: [] } };
      return { ok: true };
    });
    const { deps, states } = makeDeps(call as unknown as ProvisionDeps["call"], { launchIdentity: LAUNCH, delegationReady: true });
    const out = await runProvisionLifecycle(session, deps);
    expect(out.ok).toBe(true); // the tenant IS live (product/policy answers)…
    const last = states.at(-1)!;
    expect(last.provisionState).toBe("published");
    // …but the merchant sees exactly what is not live.
    expect(last.provisionWarning).toMatch(/Not live yet: order tools .*; customer sign-in/);
    expect(out.warnings).toContain(last.provisionWarning);
  });

  it("publishedRuntimeGaps: absent echo counts as NOT live (couldn't check ≠ green); nothing registered → no gap", () => {
    expect(publishedRuntimeGaps({ revision: 3 }, { connectorId: "c_1", identityProviderId: null })).toMatch(/order tools/);
    expect(publishedRuntimeGaps(undefined, { connectorId: null, identityProviderId: "p_1" })).toMatch(/customer sign-in/);
    expect(publishedRuntimeGaps({ connector_ids: ["c_1"], identity_provider_ids: ["p_1"] }, { connectorId: "c_1", identityProviderId: "p_1" })).toBeNull();
    expect(publishedRuntimeGaps({}, { connectorId: null, identityProviderId: null })).toBeNull();
  });
});

/**
 * #3718 — afterAuth runs on every token exchange (expiring offline tokens
 * re-exchange about once an hour). It must provision only a tenant that is NOT
 * already live: every re-run used to publish a new revision, reopening the
 * publish-to-apply window and feeding the platform's reinstall deadlock.
 */
describe("authNeedsProvision — afterAuth idempotency (#3718)", () => {
  it("a published, reachable tenant is NOT re-provisioned on a token re-exchange", () => {
    expect(authNeedsProvision({ provisionState: "published", bmaiTenantId: "t-1", tenantUnreachableAt: null })).toBe(false);
  });

  it("a fresh install (no row) provisions", () => {
    expect(authNeedsProvision(null)).toBe(true);
    expect(authNeedsProvision(undefined)).toBe(true);
  });

  it("a reinstall (suspended by app/uninstalled) provisions — the reactivation must publish", () => {
    expect(authNeedsProvision({ provisionState: "suspended", bmaiTenantId: "t-1" })).toBe(true);
  });

  it("an errored or half-provisioned row provisions", () => {
    for (const provisionState of ["error", "provisioning", "pending", null]) {
      expect(authNeedsProvision({ provisionState, bmaiTenantId: "t-1" }), String(provisionState)).toBe(true);
    }
    expect(authNeedsProvision({ provisionState: "published", bmaiTenantId: null })).toBe(true);
  });

  it("an ORPHANED published row (the platform no longer resolves its tenant) self-heals", () => {
    expect(authNeedsProvision({ provisionState: "published", bmaiTenantId: "t-gone", tenantUnreachableAt: new Date() })).toBe(true);
  });
});
