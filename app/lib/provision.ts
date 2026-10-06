/**
 * The tenant provisioning lifecycle — the install/re-auth convergence, expressed
 * as ONE injectable orchestrator so it is unit-testable WITHOUT a live Shopify
 * Partner app, a real shop, or the bmai control plane.
 *
 * ALL-OPS-VIA-MCP: every control-plane effect flows through `deps.call` (an MCP
 * `tools/call`). This module never touches Prisma or fetch directly — the caller
 * (bmai.server) injects the real MCP client + tenant-store; tests inject mocks.
 *
 * AUTHORIZATION = PROOF-OF-SHOP. The partner tools are authorized by an
 * HMAC proof-of-shop (partner+shop+proof+ts) the app signs (`partnerProof.ts`),
 * NOT a platform-operator credential. `provision_partner_tenant` homes the calling
 * OAuth identity as the tenant's ADMIN, so the tenant-admin config tools
 * (set_tenant_branding / upsert_tenant_support_connector / publish_tenant_runtime)
 * are then authorized by that same identity. The serving host is the derived slug
 * lane `<slug>.busymate.ai` (bmdev tenancy resolve.ts), so NO operator-only
 * `set_tenant_domain` is needed; the storefront origins are allowlisted for iframe
 * embedding via `add_tenant_embed_origin` (proof path).
 *
 * FAIL-CLOSED / NEVER-PARK: provision + publish are LOAD-BEARING — a failure in
 * either records an error state and STOPS (no fake success, no publish on a broken
 * tenant). The branding / embed-origin / connector / merchant-admin steps are
 * BEST-EFFORT: a soft failure is recorded but does not abort a tenant that was
 * created and taken live. Every step is idempotent, so a re-run (every re-auth) is
 * safe.
 *
 */
import { DEFAULT_ASSISTANT_NAME } from "./assistantName";
import { shopToSlug } from "./tenantSlug";
import { proofArgs, type PartnerProof } from "./partnerProof";
import { brandingArgs, identityProviderArgs, publishArgs, type IdentityProviderRegistration } from "./mgmtArgs";
import type { KnowledgeBuild, KnowledgeCounts } from "./kbSnapshot";
import { isKnowledgeRejection, publishOptionsFor, trainingPatch, type TrainingPatch } from "./kbTrain";
import { formatStoredDomains, parseStoredDomains } from "./storefrontDomains";

export interface McpResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** The minimal session shape the lifecycle needs (a subset of Shopify's Session). */
export interface ProvisionSession {
  shop: string;
  email?: string;
  accessToken?: string;
}

export interface TenantRecord {
  bmaiTenantId?: string | null;
  customDomain?: string | null;
  connectorId?: string | null;
  /** The tenant's visitor identity provider registered for this store (idempotent re-target). */
  identityProviderId?: string | null;
  provisionState?: string | null;
}

export type TenantPatch = {
  slug?: string;
  /** The store's storefront domains, comma-separated (#3718). */
  customDomain?: string | null;
  bmaiTenantId?: string | null;
  connectorId?: string | null;
  identityProviderId?: string | null;
  provisionState?: "provisioning" | "published" | "suspended" | "error";
  provisionError?: string | null;
  /**
   * A PUBLISHED tenant whose order tools / customer sign-in are NOT live in the
   * published revision (the connector or identity provider was registered but not
   * assigned — #2132 FAIL A). Null when everything registered is live.
   */
  provisionWarning?: string | null;
  publishedAt?: Date | null;
  /**
   * The meter's "the platform denied this tenant" mark. A successful publish
   * proves the tenant is reachable again, so it is cleared there (#3718): left
   * set, it kept afterAuth and Home re-repairing a healthy tenant every 10 min
   * until the next hourly meter run.
   */
  tenantUnreachableAt?: Date | null;
} & Partial<TrainingPatch>;

/**
 * The runtime origins every publish carries (install AND re-train use the same).
 * `customDomain` is the stored column: one host or a comma-separated list of the
 * store's real storefront domains (#3718 — app/lib/storefrontDomains.ts).
 */
export function runtimeOrigins(shop: string, slug: string, customDomain?: string | null): { launchOrigins: string[]; embedOrigins: string[] } {
  return {
    launchOrigins: [servingHost(slug)],
    // CSP frame-ancestors checks EVERY ancestor. Theme preview nests the store
    // inside Shopify's editor iframe and admin; allow those exact hosts, never *.
    // The store's own custom domains follow its myshopify origin so a shopper on
    // `https://www.<brand>.com` is never refused (#3718).
    embedOrigins: [`https://${shop}`, ...parseStoredDomains(customDomain).map((host) => `https://${host}`),
      "https://admin.shopify.com", "https://online-store-web.shopifyapps.com"],
  };
}

export interface ProvisionDeps {
  /** MCP `tools/call` — the ONLY control-plane effect channel. */
  call: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<McpResult<T>>;
  /** Read the current tenant row for the shop (or null). */
  getTenant: (shop: string) => Promise<TenantRecord | null>;
  /** Persist a partial tenant-state update for the shop (idempotent upsert). */
  saveTenant: (shop: string, patch: TenantPatch) => Promise<void>;
  /** The connector endpoint (`<app>/mcp`) this store registers with bmai. */
  connectorEndpoint: () => string;
  /** The storefront embed origin allowlisted for the widget. */
  embedOrigin: string;
  /**
   * Sign a proof-of-shop for (partner, shop), or null when no shared secret is
   * configured (fail-closed). Live deps use `buildPartnerProof`; tests stub it.
   */
  signProof: (partner: string, shop: string) => PartnerProof | null;
  /**
   * Is this host READY to verify Busymate AI's signed actor tokens? True iff
   * `BMAI_SUPPORT_ACTOR_MASTER` is a usable ≥32-byte secret (== what
   * `/api/bmai/status` reports as `actorVerifier`). When true the connector
   * registers with `delegation_mode:'signed_actor_token'` + the DELEGATED write
   * tools; when false it stays READ-ONLY (`none`) — the bmai control plane refuses
   * `signed_actor_token` until the app can honestly verify the HMAC, so flipping it
   * before the master is provisioned would be green-while-dead.
   */
  delegationReady: boolean;
  /**
   * Build the store's knowledge (products/policies/pages → `knowledge_sources`,
   * app/lib/kbFetch.ts) so the tenant is TRAINED in the same publish that takes
   * it live. Optional: the ops verify script has no shop session. A throw is a
   * soft failure — recorded as kbError + warned, the tenant still goes live.
   */
  buildKnowledge?: (shop: string) => Promise<KnowledgeBuild>;
  /**
   * The launch-identity provider this host publishes (app/lib/identity.ts
   * `launchIdentityRegistration`): issuer / JWKS / one-time mint endpoint of the
   * ES256 launch JWT the storefront widget hands to Busymate AI. null (or omitted)
   * when LAUNCH_SIGNING_KEY is not configured — then NO provider is registered
   * (the host could not mint a token, so a registered provider would be
   * green-while-dead) and shoppers stay anonymous with public tools only.
   */
  launchIdentity?: IdentityProviderRegistration | null;
  /**
   * The store's real storefront domains (primary + others) from the Admin API
   * (#3718 — app/lib/storefrontDomains.ts). Optional (the ops verify script has
   * no shop session) and SOFT: a failure keeps the previously stored domains.
   */
  storefrontHosts?: (shop: string) => Promise<string[]>;
}

export interface TrainingSummary {
  ok: boolean;
  error?: string;
  counts: KnowledgeCounts;
  truncated: boolean;
}

export interface ProvisionOutcome {
  ok: boolean;
  tenantId: string | null;
  connectorId: string | null;
  /** The registered visitor identity provider (null when none / not configured). */
  identityProviderId: string | null;
  error?: string;
  /** Ordered list of MCP tool names invoked — asserted by the seam test. */
  calls: string[];
  /** Non-fatal step failures (best-effort steps that did not abort). */
  warnings: string[];
  /** provision_partner_tenant brought an ARCHIVED (uninstalled) tenant back (reinstall). */
  reactivated: boolean;
  /** What the tenant was trained on in this run (null when no buildKnowledge dep). */
  training: TrainingSummary | null;
}

/** The tenant's derived serving host (the bmdev slug lane). */
export function servingHost(slug: string): string {
  return `https://${slug}.busymate.ai`;
}

/**
 * The connector tool policy tiers. Every name MUST be a tool the app's own
 * `/mcp` connector endpoint (app/mcp/tools/*) actually serves — the bmai connector
 * upsert probes the endpoint and REJECTS a tool_access entry for an undiscovered
 * tool (e.g. `start_return`, which the app serves; NOT `create_return`).
 */
export const CONNECTOR_POLICIES = {
  public_tools: ["search_products", "get_product", "list_collections"],
  identified_tools: ["get_order_status", "track_fulfillment", "list_my_orders"],
  delegated_tools: ["create_refund", "start_return", "cancel_order", "update_shipping_address", "apply_discount", "create_draft_order"],
  confirm_tools: ["create_refund", "start_return", "cancel_order", "update_shipping_address", "apply_discount", "create_draft_order"],
} as const;

/**
 * Run the full lifecycle:
 *   provision_partner_tenant (proof; reactivates an archived tenant on reinstall)
 *   → set_tenant_branding (new tenant only) → add_tenant_embed_origin (proof)
 *   → upsert connector (+ confirm_tools) → upsert identity provider (launch JWT)
 *   → buildKnowledge (products/policies/pages → knowledge_sources)
 *   → publish_tenant_runtime (origins + knowledge — ONE publish)
 *   → prove the connector + provider are ASSIGNED in the published revision
 */
export async function runProvisionLifecycle(
  session: ProvisionSession,
  deps: ProvisionDeps,
): Promise<ProvisionOutcome> {
  const shop = session.shop;
  const slug = shopToSlug(shop);
  const calls: string[] = [];
  const warnings: string[] = [];
  const partner = "shopify";
  const proof = deps.signProof(partner, shop);

  const call = async <T = unknown>(name: string, args: Record<string, unknown>) => {
    calls.push(name);
    return deps.call<T>(name, args);
  };
  /** A best-effort step: record a warning on failure, never abort. */
  const soft = async <T = unknown>(name: string, args: Record<string, unknown>) => {
    const r = await call<T>(name, args);
    if (!r.ok) warnings.push(`${name}: ${r.error ?? "failed"}`);
    return r;
  };

  const existing = await deps.getTenant(shop);
  await deps.saveTenant(shop, { slug, provisionState: "provisioning", provisionError: null });

  // 1) Provision — LOAD-BEARING. Proof-of-shop OR operator; idempotent by shop.
  const provisioned = await call<{ tenant_id: string; created?: boolean; reactivated?: boolean }>("provision_partner_tenant", {
    partner,
    shop,
    slug,
    ...proofArgs(proof),
  });
  if (!provisioned.ok) {
    await deps.saveTenant(shop, { provisionState: "error", provisionError: provisioned.error });
    return { ok: false, tenantId: null, connectorId: null, identityProviderId: null, error: provisioned.error, calls, warnings, reactivated: false, training: null };
  }
  const tenantId = provisioned.data?.tenant_id ?? existing?.bmaiTenantId ?? null;
  // Registered IDs belong to a tenant, not merely to this Shopify shop.
  const sameTenant = Boolean(tenantId && existing?.bmaiTenantId === tenantId);
  // REINSTALL: app/uninstalled archived the tenant (suspend_tenant); under a valid
  // proof provision_partner_tenant reactivates it (status active + runtime
  // re-projection) and says so. The publish below re-takes it live either way.
  const reactivated = provisioned.data?.reactivated === true;

  // #3718 — the store's REAL storefront domains (a custom domain is where most
  // shoppers are). Soft: a failed read keeps what was stored before.
  let customDomain = existing?.customDomain ?? null;
  if (deps.storefrontHosts) {
    try {
      const hosts = await deps.storefrontHosts(shop);
      customDomain = formatStoredDomains([...hosts, ...parseStoredDomains(existing?.customDomain)]);
    } catch (err) {
      warnings.push(`storefront domains: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  }

  // Storefront parent origins allowed to iframe-embed the assistant.
  const origins = runtimeOrigins(shop, slug, customDomain);
  const storefrontOrigins = origins.embedOrigins;

  // 2) Branding (proof-of-shop path — re-resolves tenant from the proven shop, so the
  //    provisioner needs NO platform-operator role; #1982 security follow-up #5).
  //    ONLY for a NEW tenant: a reinstall / Connector re-run / re-auth of an existing
  //    tenant must NEVER overwrite the merchant's saved names with the defaults
  //    (#2132 C — the review store's rename was wiped by the reinstall). The publish
  //    below re-reads the tenant row, so an existing tenant keeps its branding.
  const isNewTenant = provisioned.data?.created === true || (!existing?.bmaiTenantId && provisioned.data?.reactivated !== true);
  if (isNewTenant) {
    await soft("set_tenant_branding", brandingArgs(proof, tenantId, { productName: shop, assistantName: DEFAULT_ASSISTANT_NAME }));
  }

  // 3) Storefront embed-origin allowlist (proof path — re-resolves tenant from shop).
  await soft("add_tenant_embed_origin", { ...proofArgs(proof), origins: storefrontOrigins, confirm: true });

  // NOTE: the merchant is NOT homed via add_tenant_admin here — that tool needs the
  // merchant's bmai `user_id`, which a Shopify install does not provide (only an
  // email, and an offline install none). The mgmt steps below authorize by
  // PROOF-OF-SHOP (each re-resolves the tenant from the proven shop), so the
  // provisioner needs no platform-operator role (can_manage_tenant_support_for_user's
  // tenant-admin arm requires current_tenant == target, which a multi-tenant
  // provisioner never satisfies); the merchant is linked on first bmai sign-in.

  // 5) Register the per-store Shopify Admin connector (signed_actor_token + 4 tiers).
  // Unauthenticated server access (`auth_mode:'none'`); the per-user delegation mode
  // is gated on the app's actor-token verifier being READY (deps.delegationReady ==
  // /api/bmai/status actorVerifier). READY → `signed_actor_token` + the DELEGATED
  // write tools (refunds/returns/cancel/address/discount/draft), each still
  // confirm-gated + actor-scoped. NOT READY → READ-ONLY (`none`, public+identified
  // only): the bmai control plane refuses `signed_actor_token` until the host can
  // honestly verify the HMAC, so we never make a claim we can't back (no
  // green-while-dead). The step is idempotent — provisioning the master and
  // re-running Connector → Re-provision flips it live.
  const delegationMode = deps.delegationReady ? "signed_actor_token" : "none";
  const connector = await soft<{ id?: string; connector?: { id?: string } }>("upsert_tenant_support_connector", {
    ...proofArgs(proof),
    tenant_id: tenantId,
    ...(sameTenant && existing?.connectorId ? { connector_id: existing.connectorId } : {}),
    endpoint: deps.connectorEndpoint(),
    namespace: "shopify-admin",
    title: "Shopify Admin",
    // #2482 — description is REQUIRED by the platform (bmai #2482): an empty
    // value here (this call never set one) broke the shared registry
    // export's own schema once the connector was projected. Fixed at the
    // source rather than only downstream.
    description: "Shop order tools — order status, tracking, and (when delegated) refunds, returns, cancellations, address updates, discounts, and draft orders.",
    auth_mode: "none",
    delegation_mode: delegationMode,
    tool_access: connectorToolAccess(deps.delegationReady),
    // Every DELEGATED write is confirm-gated on the platform (#2132): the
    // assistant parks the call until the shopper approves it in chat. Registered
    // in lockstep with the delegated tier — no delegated tools, nothing to gate.
    ...(deps.delegationReady ? { confirm_tools: [...CONNECTOR_POLICIES.confirm_tools] } : {}),
    confirm: true,
  });
  // The tool returns { ok, id, connector: { id } } — capture the connector's id.
  // PRESERVE a previously-captured id: the connector step is BEST-EFFORT and an
  // idempotent re-upsert (every re-auth) may return ok without re-echoing the id,
  // so falling back to `null` would NULL a good connectorId and regress the app's
  // "connector registered" state on every re-auth. Fall back to the existing id.
  const connectorId =
    connector.data?.id ?? connector.data?.connector?.id ?? (sameTenant ? existing?.connectorId : null) ?? null;

  // 5b) Register this host as the tenant's VISITOR IDENTITY PROVIDER (#2132 FAIL A).
  // The storefront widget fetches a launch JWT from /identity (App Proxy, HMAC-
  // verified customer id) and hands it to Busymate AI's support-launch, which
  // trusts ONLY a provider registered for the token's issuer. Without this step
  // every signed-in shopper fell back to anonymous, so the identified/delegated
  // order tools could never be offered. `delegated_access` mirrors the connector's
  // delegation readiness. Idempotent: re-targets the persisted provider id.
  // Best-effort like the connector: a denial is recorded, the tenant still goes live.
  let identityProviderId: string | null = (sameTenant ? existing?.identityProviderId : null) ?? null;
  if (deps.launchIdentity) {
    const provider = await soft<{ provider?: { id?: string }; id?: string }>(
      "upsert_tenant_identity_provider",
      identityProviderArgs(proof, tenantId, shop, deps.launchIdentity, {
        providerId: identityProviderId,
        delegatedAccess: deps.delegationReady,
      }),
    );
    identityProviderId = provider.data?.provider?.id ?? provider.data?.id ?? identityProviderId;
  }

  // 6) Train — build the store knowledge (products / policies / pages) so the
  //    publish below carries `knowledge_sources`. SOFT: a failure is persisted as
  //    kbError + surfaced on Home/Store connection, and the tenant still goes live
  //    (an un-trained assistant that says so beats no assistant at all).
  let knowledge: KnowledgeBuild | null = null;
  let training: TrainingPatch | null = null;
  let trainingSummary: TrainingSummary | null = null;
  if (deps.buildKnowledge) {
    try {
      knowledge = await deps.buildKnowledge(shop);
      training = trainingPatch(knowledge, new Date());
      trainingSummary = { ok: true, counts: knowledge.counts, truncated: knowledge.truncated };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      warnings.push(`knowledge: ${message}`);
      training = { kbError: message };
      trainingSummary = { ok: false, error: message, counts: { products: 0, policies: 0, pages: 0 }, truncated: false };
    }
  }

  // 7) Publish the runtime — LOAD-BEARING (the step that makes the widget resolve).
  //    ONE publish carrying origins + knowledge. If the edge refuses the KNOWLEDGE
  //    payload specifically, re-publish without it so the tenant is still live and
  //    the rejection is surfaced as the training error.
  let published = await call<{ revision?: number }>("publish_tenant_runtime", publishArgs(proof, tenantId, publishOptionsFor(knowledge, origins)));
  if (!published.ok && knowledge && knowledge.sources.length && isKnowledgeRejection(published.error)) {
    const message = `publish_tenant_runtime: ${published.error ?? "failed"}`.slice(0, 500);
    warnings.push(`knowledge: ${message}`);
    training = { kbError: message };
    trainingSummary = { ok: false, error: message, counts: knowledge.counts, truncated: knowledge.truncated };
    published = await call("publish_tenant_runtime", publishArgs(proof, tenantId, publishOptionsFor(null, origins)));
  }
  if (!published.ok) {
    await deps.saveTenant(shop, {
      bmaiTenantId: tenantId,
      connectorId,
      identityProviderId,
      provisionState: "error",
      provisionError: `publish_tenant_runtime: ${published.error ?? "failed"}`,
      ...(training ?? {}),
    });
    return { ok: false, tenantId, connectorId, identityProviderId, error: published.error, calls, warnings, reactivated, training: trainingSummary };
  }

  // 8) PROVE the order tools are live (#2132 FAIL A). A registered connector /
  //    provider is NOT live until the published revision ASSIGNS it; the publish
  //    result echoes what it assigned (`connector_ids` / `identity_provider_ids`).
  //    A registration the revision does not carry — or a platform that does not
  //    echo assignments at all — is reported as a warning the merchant can see,
  //    never a silent "Connected" over an assistant that cannot see orders.
  const provisionWarning = publishedRuntimeGaps(published.data, { connectorId, identityProviderId });
  if (provisionWarning) warnings.push(provisionWarning);

  await deps.saveTenant(shop, {
    bmaiTenantId: tenantId,
    connectorId,
    identityProviderId,
    customDomain,
    provisionState: "published",
    provisionError: null,
    provisionWarning,
    publishedAt: new Date(),
    tenantUnreachableAt: null,
    ...(training ?? {}),
  });

  return { ok: true, tenantId, connectorId, identityProviderId, calls, warnings, reactivated, training: trainingSummary };
}

/**
 * The published-revision assignment check (#2132 FAIL A): which registered
 * capabilities the publish result does NOT carry. Returns the merchant-facing
 * warning, or null when every registration is live. An absent echo counts as
 * NOT live (fail closed — "couldn't check" is never green).
 */
export function publishedRuntimeGaps(
  result: unknown,
  registered: { connectorId: string | null; identityProviderId: string | null },
): string | null {
  const r = (result && typeof result === "object" ? result : {}) as { connector_ids?: unknown; identity_provider_ids?: unknown };
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const gaps: string[] = [];
  if (registered.connectorId && !ids(r.connector_ids).includes(registered.connectorId)) {
    gaps.push("order tools (the store connection is registered but not assigned to the published assistant)");
  }
  if (registered.identityProviderId && !ids(r.identity_provider_ids).includes(registered.identityProviderId)) {
    gaps.push("customer sign-in (the identity provider is registered but not assigned to the published assistant)");
  }
  if (!gaps.length) return null;
  return `Not live yet: ${gaps.join("; ")}. Shoppers get product and policy answers only — reconnect after the Busymate AI platform update, or contact support.`;
}

/** The tenant-row slice the afterAuth decision reads. */
export interface AuthTenantState {
  provisionState?: string | null;
  bmaiTenantId?: string | null;
  tenantUnreachableAt?: Date | string | null;
}

/**
 * AFTER-AUTH IDEMPOTENCY (#3718 — Shopify review 5.1.2).
 *
 * `afterAuth` runs on every token exchange, not only on install: with EXPIRING
 * offline tokens (`expiringOfflineAccessTokens`, ~1 h) the first admin load after
 * an hour re-runs it, and it used to re-run the WHOLE lifecycle — a new
 * `publish_tenant_runtime` revision each time. Every re-publish reopened the
 * publish-to-apply window in which the storefront chat could not start, and on a
 * reinstalled store it fed the platform's reinstall deadlock (a reviewer store,
 * revision 5 at 19:09). The token refresh itself is the library's job;
 * provisioning is needed only when the tenant is NOT already live:
 *
 *   • no row / never published / suspended (a reinstall) / error → provision;
 *   • a published row whose tenant the platform no longer resolves
 *     (`tenantUnreachableAt`, set by the meter on `tenant_management_denied`)
 *     → provision: the orphan self-heals on the merchant's next admin open;
 *   • otherwise → no provisioning on the auth path. The live row is CHECKED in
 *     the background instead (`checkPublishedTenant`, app/lib/tenantRepair.ts):
 *     a tenant the platform no longer resolves (`get_tenant_integration` answers
 *     "administration denied" / "unavailable" → readiness `orphaned`, no meter
 *     flag needed) or a storefront domain missing from the published allowlist
 *     is repaired by the same idempotent lifecycle, gated per shop.
 */
export function authNeedsProvision(row: AuthTenantState | null | undefined): boolean {
  if (!row) return true;
  if (row.provisionState !== "published") return true;
  if (!row.bmaiTenantId) return true;
  return Boolean(row.tenantUnreachableAt);
}

/**
 * INSTALL-TIME GUARD — the ONLY entry point afterAuth may call.
 *
 * `runProvisionLifecycle` records `error` state for a failed MCP step but still
 * THROWS at its dependency boundary (a Prisma `getTenant`/`saveTenant` write — e.g.
 * a `P2002` unique-constraint race when Shopify's App-Bridge double-bounce fires
 * two concurrent installs for the same new shop). afterAuth MUST NOT throw: the
 * Shopify token-exchange strategy converts ANY afterAuth throw into a bare
 * `500 Internal Server Error` on the embedded app's FIRST load — which is exactly
 * the App Store review failure (Req 2.1.1 "no critical errors" / 2.1.3 "an
 * interactive UI, not a web 500"). This guard GUARANTEES it never throws: a
 * provisioning failure is recorded as an operational error state that the app UI
 * surfaces (Req 2.1.3 explicitly permits operational errors) and every re-auth /
 * the Connector "Retry" re-runs the idempotent lifecycle.
 */
export async function provisionOnInstall(
  session: ProvisionSession,
  deps: ProvisionDeps,
): Promise<ProvisionOutcome> {
  try {
    return await runProvisionLifecycle(session, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      // A concurrent install can WIN the race and publish this tenant while our
      // attempt throws a unique-constraint error at the write boundary — don't
      // stomp a good `published` state with a bogus `error`.
      const existing = await deps.getTenant(session.shop);
      if (existing?.bmaiTenantId) {
        return {
          ok: true,
          tenantId: existing.bmaiTenantId,
          connectorId: null,
          identityProviderId: null,
          calls: [],
          warnings: [`provisionOnInstall raced; tenant already provisioned: ${message}`],
          reactivated: false,
          training: null,
        };
      }
      await deps.saveTenant(session.shop, {
        slug: shopToSlug(session.shop),
        provisionState: "error",
        provisionError: message.slice(0, 500),
      });
    } catch {
      // Best-effort: even recording the error must not throw out of afterAuth.
    }
    return {
      ok: false,
      tenantId: null,
      connectorId: null,
      identityProviderId: null,
      error: message,
      calls: [],
      warnings: [`provisionOnInstall threw: ${message}`],
      reactivated: false,
      training: null,
    };
  }
}

/**
 * Per-tool access classification for upsert_tenant_support_connector. The READ
 * tiers (public + identified) always register. The DELEGATED write tier registers
 * only when `includeDelegated` (the actor-token verifier is ready) — the bmai
 * control plane refuses a delegated tool_access entry unless the host can verify
 * the signed actor token, so this is gated in lockstep with `delegation_mode`.
 */
export function connectorToolAccess(
  includeDelegated = false,
): Record<string, "public" | "identified" | "delegated"> {
  const out: Record<string, "public" | "identified" | "delegated"> = {};
  for (const t of CONNECTOR_POLICIES.public_tools) out[t] = "public";
  for (const t of CONNECTOR_POLICIES.identified_tools) out[t] = "identified";
  if (includeDelegated) for (const t of CONNECTOR_POLICIES.delegated_tools) out[t] = "delegated";
  return out;
}
