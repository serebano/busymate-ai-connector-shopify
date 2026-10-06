/**
 * bmai / Busymate AI integration — the ONLY way this app touches the Busymate control plane.
 *
 * ALL-OPS-VIA-MCP (a bmdev/bmai invariant): this app reaches bmai strictly through
 * MCP tools + the connector protocol — never a backdoor Supabase DB/storage write.
 * If a needed operation has no MCP tool, the fix is to expose the tool in bmdev,
 * not to reach around it here.
 *
 * AUTH: every `tools/call` carries a bmai OAuth 2.1 access token, minted + kept
 * fresh by the durable token provider (`lib/bmaiToken.ts`) from a rotating refresh
 * token. AUTHORIZATION of the partner tenant tools is PROOF-OF-SHOP (`lib/partnerProof.ts`).
 *
 * The install callback runs the LIVE MCP tenant lifecycle:
 *   provision_partner_tenant (proof; reactivates an archived tenant on reinstall)
 *   → set_tenant_branding → add_tenant_embed_origin (proof) → register connector
 *   → build the store knowledge (products/policies/pages) → publish_tenant_runtime
 *   (origins + knowledge_sources — the tenant is TRAINED in the publish that takes it live)
 *
 * FAIL-CLOSED: no credential ⇒ the op returns an error, never fake success
 * (green-while-dead).
 *
 */
import type { Session } from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { shopToSlug } from "./lib/tenantSlug";
import { connectorEndpoint } from "./lib/connector";
import { authNeedsProvision, provisionOnInstall, type ProvisionDeps } from "./lib/provision";
import { buildPartnerProof, proofArgs } from "./lib/partnerProof";
import { createTokenProvider, type TokenStore } from "./lib/bmaiToken";
import { decryptField, encryptField } from "./lib/fieldCipher";
import { masterSecretUsable } from "./mcp/actorToken";
import { brandingArgs, publishArgs, type Branding, type PublishOptions } from "./lib/mgmtArgs";
import { buildKnowledgeForShop } from "./lib/kbFetch";
import { fetchStorefrontHosts } from "./lib/storefrontDomains";
import { adminForShop } from "./mcp/shopifyAdmin";
import { launchIdentityRegistration } from "./lib/identity";
import { resolveBusymateAiMcpUrl } from "./lib/bmaiSurface";
import { readRuntimeReadiness } from "./lib/runtimeReadiness";
import { checkPublishedTenant, createRepairGate, publishedTenantRepair, type RepairDecision } from "./lib/tenantRepair";

// One product, one protocol surface. Partner proof-of-shop lifecycle and tenant
// management are both Busymate AI operations and therefore use busymate.ai/mcp.
// Never route them through the separate Busymate DevTools MCP.
const MCP_URL = resolveBusymateAiMcpUrl(process.env.BMAI_MGMT_MCP_URL);
const EMBED_ORIGIN = process.env.BMAI_EMBED_ORIGIN || "https://busymate.ai";

export interface McpResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Prisma-backed store for a rotating refresh token, keyed by credential id. */
function makeTokenStore(id: string): TokenStore {
  return {
    load: async () => {
      const row = await prisma.bmaiCredential.findUnique({ where: { id } });
      // The rotating refresh token is stored encrypted at rest; decrypt on load
      // (legacy plaintext rows pass through unchanged).
      return row ? { clientId: row.clientId, refreshToken: decryptField(row.refreshToken) } : null;
    },
    save: async (v) => {
      const refreshToken = encryptField(v.refreshToken);
      await prisma.bmaiCredential.upsert({
        where: { id },
        create: { id, clientId: v.clientId, refreshToken },
        update: { clientId: v.clientId, refreshToken },
      });
    },
  };
}

// One RFC-8707 resource and one durable rotating credential for every Busymate
// AI call. The existing `mgmt` store id is preserved so deployed refresh-token
// rotation survives this code upgrade without re-authorization.
const tokenProvider = createTokenProvider({
  mcpUrl: MCP_URL,
  staticToken: process.env.BMAI_MGMT_TOKEN || undefined,
  seedClientId: process.env.BMAI_MGMT_CLIENT_ID || undefined,
  seedRefreshToken: process.env.BMAI_MGMT_REFRESH_TOKEN || undefined,
  store: makeTokenStore("mgmt"),
});

/** Sign a proof-of-shop for a shop (fail-closed to null when no secret is set). */
function shopProof(shop: string) {
  return buildPartnerProof("shopify", shop);
}

/**
 * MCP JSON-RPC 2.0 `tools/call` client. Mints/refreshes the OAuth bearer via the
 * token provider and retries once on a 401 (expired token → force re-mint).
 */
export async function callMcpTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
): Promise<McpResult<T>> {
  let token: string;
  try {
    token = await tokenProvider.getAccessToken();
  } catch (err) {
    // Fail LOUD, not silently-green: no credential ⇒ the op did NOT happen.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const doFetch = (bearer: string) =>
    fetch(MCP_URL, {
      method: "POST",
      // A status read must not hold an embedded admin request indefinitely.
      signal: name === "get_tenant_integration" ? AbortSignal.timeout(8000) : undefined,
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });

  try {
    let res = await doFetch(token);
    if (res.status === 401) {
      // Retry ONCE after the (single-flight) refresh resolves; token-aware so a
      // concurrent caller's fresher token is reused rather than rotated again.
      tokenProvider.invalidate(token);
      token = await tokenProvider.getAccessToken();
      res = await doFetch(token);
    }
    const json = (await res.json()) as {
      result?: { content?: unknown; structuredContent?: T; isError?: boolean };
      error?: { message?: string };
    };
    if (json.error) return { ok: false, error: json.error.message ?? "mcp error" };
    if (json.result?.isError) return { ok: false, error: toolErrorText(json.result) };
    // A NON-widget bmdev tool returns its JSON only in the `content` text block
    // (structuredContent is emitted for widget-linked tools). Parse both so we
    // reliably capture tenant_id / connector_id.
    const data = json.result?.structuredContent ?? parseToolContent<T>(json.result?.content);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Concatenate the text parts of an MCP tool-result content array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
    .filter(Boolean)
    .join(" ");
}

/** Best-effort parse of a tool result's JSON payload from its text content. */
function parseToolContent<T>(content: unknown): T | undefined {
  const text = contentText(content).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Extract a readable message from an isError tool result (text content). */
function toolErrorText(result: { content?: unknown }): string {
  return contentText(result.content) || "tool returned isError";
}

/** Real production deps for the provisioning lifecycle (MCP + Prisma tenant-store). */
function liveProvisionDeps(): ProvisionDeps {
  return {
    call: callMcpTool,
    getTenant: (shop) =>
      prisma.shopTenant.findUnique({
        where: { shop },
        // connectorId is read back so a best-effort re-upsert that doesn't re-echo
        // the id preserves it instead of nulling the "connector registered" state.
        select: { bmaiTenantId: true, customDomain: true, connectorId: true, identityProviderId: true },
      }),
    saveTenant: async (shop, patch) => {
      const slug = patch.slug ?? shopToSlug(shop);
      await prisma.shopTenant.upsert({
        where: { shop },
        create: { shop, slug, ...patch },
        update: patch,
      });
    },
    connectorEndpoint,
    embedOrigin: EMBED_ORIGIN,
    signProof: (partner, shop) => buildPartnerProof(partner, shop),
    // Register delegated writes only once this host can verify Busymate AI's actor
    // tokens (BMAI_SUPPORT_ACTOR_MASTER present) — mirrors /api/bmai/status.
    delegationReady: masterSecretUsable(process.env.BMAI_SUPPORT_ACTOR_MASTER),
    // Train on the store in the same publish (Admin GraphQL through the refreshing
    // offline session). A failure is recorded as kbError, never blocks going live.
    buildKnowledge: buildKnowledgeForShop,
    // #3718 — the store's real storefront domains (primary + others) join the
    // embed-origin allowlist, so a shopper on a custom domain is never refused.
    // Soft: a failed read keeps the previously stored domains.
    storefrontHosts: async (shop) => fetchStorefrontHosts(await adminForShop(shop)),
    // Register this host's launch-JWT issuer as the tenant's visitor identity
    // provider (#2132 FAIL A) — only when the signing key exists (== /api/bmai/status
    // launchIdentity), so a provider is never registered for tokens we cannot mint.
    launchIdentity: launchIdentityRegistration(),
  };
}

/**
 * Install / re-auth convergence. Idempotent: safe to re-run on every afterAuth.
 * Delegates to the injectable orchestrator (app/lib/provision.ts) so the sequence
 * is unit-tested with mocks; here we bind the real MCP client + Prisma tenant-store.
 *
 * NEVER THROWS — calls the `provisionOnInstall` guard (not `runProvisionLifecycle`
 * directly). afterAuth runs inside Shopify's token-exchange strategy, which turns
 * any afterAuth throw into a bare `500 Internal Server Error` on the embedded app's
 * first load (App Store Req 2.1.1 / 2.1.3). A provisioning failure is therefore
 * recorded as an operational error state the app UI surfaces + the next re-auth /
 * Connector "Retry" re-runs — never a web 500 that blocks the merchant UI.
 */
export async function onAppInstalled(session: Session): Promise<void> {
  // email is best-effort: present only on an ONLINE session (associated user);
  // an offline install has none, so add_tenant_admin is skipped until app.settings.
  const email = session.onlineAccessInfo?.associated_user?.email ?? undefined;
  const outcome = await provisionOnInstall(
    { shop: session.shop, email, accessToken: session.accessToken },
    liveProvisionDeps(),
  );
  if (!outcome.ok) {
    // Recorded as error state for the UI; log for operability. Not re-thrown.
    console.error(`[bmai] onAppInstalled did not publish ${session.shop}: ${outcome.error ?? "unknown"}`);
  } else {
    const t = outcome.training;
    console.log(
      `[bmai] ${outcome.reactivated ? "reinstalled (tenant reactivated)" : "published"} ${session.shop} tenant=${outcome.tenantId}` +
        (t ? (t.ok ? ` trained: ${t.counts.products} products, ${t.counts.policies} policies, ${t.counts.pages} pages${t.truncated ? " (truncated to fit)" : ""}` : ` NOT trained: ${t.error}`) : ""),
    );
  }
  // Best-effort (soft) step failures don't block publish, but log them so a
  // silently-degraded connector/branding step is visible in operations.
  if (outcome.warnings.length) {
    console.warn(`[bmai] onAppInstalled warnings for ${session.shop}: ${outcome.warnings.join(" | ")}`);
  }
}

/**
 * set_tenant_branding via MCP — the proof-signed `branding:{…}` + confirm shape
 * (identical to the provisioning lifecycle). Used by the settings save. A missing
 * tenant is a fail-closed error, never a silent no-op.
 */
export async function setTenantBranding(
  shop: string,
  tenantId: string | null | undefined,
  branding: Branding,
): Promise<McpResult> {
  if (!tenantId) return { ok: false, error: "no provisioned tenant for this shop yet" };
  return callMcpTool("set_tenant_branding", brandingArgs(shopProof(shop), tenantId, branding));
}

/**
 * publish_tenant_runtime via MCP — the proof-signed + confirm shape. Used by the
 * re-train path (origins + the compressed `knowledge_sources`). Fail-closed on a
 * missing tenant.
 */
export async function publishTenantRuntime(
  shop: string,
  tenantId: string | null | undefined,
  opts: PublishOptions,
): Promise<McpResult> {
  if (!tenantId) return { ok: false, error: "no provisioned tenant for this shop yet" };
  return callMcpTool("publish_tenant_runtime", publishArgs(shopProof(shop), tenantId, opts));
}

/**
 * Re-run the idempotent provisioning lifecycle for a shop WITHOUT an admin
 * request (the reconcile sweep, #3718). Admin reads go through the stored,
 * refreshing offline session (`adminForShop`). Never throws.
 */
export async function reprovisionShop(shop: string) {
  return provisionOnInstall({ shop }, liveProvisionDeps());
}

/**
 * #3718 — a PUBLISHED tenant is repaired (the idempotent lifecycle, in the
 * background) only for a definite reason: the platform no longer resolves it,
 * or the store has a storefront domain its allowlist lacks. Gated per shop so a
 * persistent answer never becomes a re-publish on every admin open, webhook or
 * Home poll. See app/lib/tenantRepair.ts.
 */
const repairGate = createRepairGate({ cooldownMs: 10 * 60_000 });

export function repairTenantInBackground(shop: string, decision: RepairDecision): boolean {
  if (!repairGate.tryStart(shop)) return false;
  console.log(`[bmai] repair ${shop}: ${decision.reason} — ${decision.detail}`);
  void reprovisionShop(shop)
    .then(
      (out) => console.log(`[bmai] repair ${shop} (${decision.reason}): ${out.ok ? `ok tenant=${out.tenantId}` : `failed: ${out.error ?? "unknown"}`}`),
      (err) => console.error(`[bmai] repair ${shop} (${decision.reason}) threw: ${err instanceof Error ? err.message : String(err)}`),
    )
    .finally(() => repairGate.finish(shop));
  return true;
}

const liveCheckDeps = {
  readReadiness: (tenantId: string) => readRuntimeReadiness(tenantId, callMcpTool),
  readFreshHosts: async (shop: string) => fetchStorefrontHosts(await adminForShop(shop)),
  repair: (shop: string, decision: RepairDecision) => { repairTenantInBackground(shop, decision); },
};

/**
 * The afterAuth hook's entry point (#3718): provision only when the tenant is
 * not already live — see `authNeedsProvision`. An expiring offline token's
 * re-exchange (every admin open after ~1 h) no longer re-publishes a live
 * tenant; instead a live row is CHECKED in the background (orphaned tenant,
 * storefront domains added since the last publish) and repaired only on a
 * definite answer. NEVER THROWS and never delays the admin load: an unreadable
 * row falls through to the idempotent, never-throwing lifecycle, exactly as
 * before.
 */
export async function onAfterAuth(session: Session): Promise<void> {
  // A completed auth means the shop is installed and reachable again: clear an
  // inactive marker (#52 — reinstall after uninstall, or a store that came back).
  await prisma.shopTenant
    .updateMany({ where: { shop: session.shop, inactiveAt: { not: null } }, data: { inactiveAt: null, inactiveReason: null } })
    .catch(() => null);
  let row: {
    provisionState?: string | null;
    bmaiTenantId?: string | null;
    tenantUnreachableAt?: Date | null;
    customDomain?: string | null;
  } | null = null;
  try {
    row = await prisma.shopTenant.findUnique({
      where: { shop: session.shop },
      select: { provisionState: true, bmaiTenantId: true, tenantUnreachableAt: true, customDomain: true },
    });
  } catch {
    row = null;
  }
  if (!authNeedsProvision(row)) {
    console.log(`[bmai] afterAuth ${session.shop}: tenant already live (${row?.bmaiTenantId}) — checking, no re-publish`);
    void checkPublishedTenant(
      { shop: session.shop, bmaiTenantId: row!.bmaiTenantId!, customDomain: row?.customDomain, tenantUnreachableAt: row?.tenantUnreachableAt },
      liveCheckDeps,
    ).catch(() => null);
    return;
  }
  await onAppInstalled(session);
}

/**
 * `domains/create|update|destroy` (#3718): re-read the store's storefront
 * domains and repair the tenant when one is missing from its published
 * allowlist. Background, gated, never throws.
 */
export async function refreshStorefrontDomains(shop: string): Promise<RepairDecision | null> {
  try {
    const row = await prisma.shopTenant.findUnique({
      where: { shop },
      select: { provisionState: true, bmaiTenantId: true, customDomain: true },
    });
    if (row?.provisionState !== "published" || !row.bmaiTenantId) return null;
    const fresh = await fetchStorefrontHosts(await adminForShop(shop));
    const decision = publishedTenantRepair({ readiness: null, storedDomains: row.customDomain, freshHosts: fresh });
    if (decision) repairTenantInBackground(shop, decision);
    return decision;
  } catch (err) {
    console.error(`[bmai] domains refresh ${shop}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** app/uninstalled → suspend/teardown the tenant (never hard-delete on uninstall). */
export async function onAppUninstalled(shop: string): Promise<void> {
  const row = await prisma.shopTenant.findUnique({ where: { shop } });
  // Mark the shop suspended + INACTIVE first (#52): retraining stops even when the
  // platform suspend below fails, and the freshness backstop/health skip it.
  await prisma.shopTenant.updateMany({
    where: { shop },
    data: { provisionState: "suspended", inactiveAt: new Date(), inactiveReason: "uninstalled" },
  });
  await prisma.session.deleteMany({ where: { shop } });
  if (row?.bmaiTenantId) {
    await callMcpTool("suspend_tenant", { ...proofArgs(shopProof(shop)), confirm: true });
  }
}

/** shop/redact (GDPR, 48h after uninstall) → full tenant teardown + data purge. */
export async function onShopRedact(shop: string): Promise<void> {
  const { purgeReingest } = await import("./lib/reingestStore.server");
  await purgeReingest(shop);
  const row = await prisma.shopTenant.findUnique({ where: { shop } });
  if (row?.bmaiTenantId) {
    await callMcpTool("delete_tenant", { ...proofArgs(shopProof(shop)), confirm: true });
  }
  await prisma.billingState.deleteMany({ where: { shop } });
  await prisma.shopTenant.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });
}

/**
 * customers/data_request (GDPR) → export the identified customer's held data
 * from the tenant (conversations/actions) via MCP, for the merchant to deliver.
 * Returns ok:false (never silently green) when there is no provisioned tenant.
 */
export async function exportTenantCustomerData(
  shop: string,
  customerId: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await prisma.shopTenant.findUnique({ where: { shop } });
  if (!row?.bmaiTenantId) return { ok: false, error: "no tenant for shop" };
  const res = await callMcpTool("export_tenant_customer_data", {
    ...proofArgs(shopProof(shop)),
    external_customer_id: customerId,
  });
  return { ok: res.ok, error: res.error };
}

/**
 * customers/redact (GDPR) → erase that customer's transcripts/PII from the tenant
 * KB via MCP. Idempotent: a redact for an unknown/already-erased customer is ok.
 */
export async function redactTenantCustomer(
  shop: string,
  customerId: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await prisma.shopTenant.findUnique({ where: { shop } });
  if (!row?.bmaiTenantId) return { ok: true }; // nothing to erase — idempotent
  const res = await callMcpTool("redact_tenant_customer", {
    ...proofArgs(shopProof(shop)),
    external_customer_id: customerId,
    confirm: true,
  });
  return { ok: res.ok, error: res.error };
}
