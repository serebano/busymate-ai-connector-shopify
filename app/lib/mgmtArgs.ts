import { proofArgs, type PartnerProof } from "./partnerProof";
import type { KnowledgeSource } from "./kbSnapshot";

/**
 * Shared argument builders for the bmai tenant-MANAGEMENT tools
 * (`set_tenant_branding`, `publish_tenant_runtime`). Provisioning
 * (`app/lib/provision.ts`), the settings save (`app/routes/app.settings.tsx`) and
 * KB re-ingest (`app/lib/ingest.ts`) ALL build their calls here, so every caller
 * carries the SAME proof-of-shop + `confirm:true` shape the bmai edge verifies
 * (mismatched/proofless args are silently refused — the B13 bug this closes).
 */

export interface Branding {
  productName: string;
  assistantName: string;
  logoUrl?: string;
  themeColor?: string;
}

/** `set_tenant_branding` — proof-of-shop + `branding:{…}` + confirm. */
export function brandingArgs(
  proof: PartnerProof | null,
  tenantId: string | null | undefined,
  branding: Branding,
): Record<string, unknown> {
  return { ...proofArgs(proof), tenant_id: tenantId, branding, confirm: true };
}

export interface PublishOptions {
  launchOrigins?: string[];
  embedOrigins?: string[];
  /**
   * The store's compressed knowledge (app/lib/kbSnapshot.ts) — the platform's ONE
   * tenant-knowledge write path (`knowledge_sources`: replace-by-key, ≤40 sources,
   * ≤20,000 chars each, ≤40,000 total). An empty list is OMITTED (the edge rejects
   * an empty array; an empty store simply publishes without knowledge).
   * NOTE: the former `kb_snapshot` arg was not in the edge's input schema and was
   * silently ignored — never emit it.
   */
  knowledgeSources?: KnowledgeSource[];
  /**
   * busymate-ai-src#2704 (Shopify review S4) — the tenant's PUBLIC hosted chat page
   * (`shop-<store>.busymate.ai`). `false` while the storefront is password-protected:
   * the assistant then lives only in the storefront widget's frame. Omitted = the
   * platform keeps its current behaviour.
   */
  hostedWeb?: boolean;
}

/** `publish_tenant_runtime` — proof-of-shop + confirm, with optional origins/knowledge. */
export function publishArgs(
  proof: PartnerProof | null,
  tenantId: string | null | undefined,
  opts: PublishOptions = {},
): Record<string, unknown> {
  return {
    ...proofArgs(proof),
    tenant_id: tenantId,
    ...(opts.launchOrigins ? { launch_origins: opts.launchOrigins } : {}),
    ...(opts.embedOrigins ? { embed_origins: opts.embedOrigins } : {}),
    ...(opts.knowledgeSources && opts.knowledgeSources.length ? { knowledge_sources: opts.knowledgeSources } : {}),
    ...(typeof opts.hostedWeb === "boolean" ? { hosted_web: opts.hostedWeb } : {}),
    confirm: true,
  };
}

/**
 * `upsert_tenant_identity_provider` — proof-of-shop + the PUBLIC verification
 * metadata of this host's launch tokens (#2132 FAIL A). One provider per store,
 * bound to the store by the `shop` tenant claim; `provider_id` re-targets the
 * SAME row on every idempotent re-run (a fresh id per run would register
 * duplicate providers for one issuer). `delegated_access` mirrors the
 * connector's delegation readiness: only a host that can verify actor tokens
 * may let an identified shopper's session authorize delegated order tools.
 */
export interface IdentityProviderRegistration {
  issuer: string;
  jwksUri: string;
  identityEndpointUrl: string;
  audience: string;
  tenantClaim: string;
  maxTokenAgeSeconds: number;
}

export function identityProviderArgs(
  proof: PartnerProof | null,
  tenantId: string | null | undefined,
  shop: string,
  reg: IdentityProviderRegistration,
  opts: { providerId?: string | null; delegatedAccess: boolean },
): Record<string, unknown> {
  return {
    ...proofArgs(proof),
    tenant_id: tenantId,
    ...(opts.providerId ? { provider_id: opts.providerId } : {}),
    label: "Shopify customer accounts",
    issuer: reg.issuer,
    jwks_uri: reg.jwksUri,
    audiences: [reg.audience],
    tenant_claim: reg.tenantClaim,
    tenant_claim_value: shop,
    subject_claim: "sub",
    allowed_algs: ["ES256"],
    max_token_age_seconds: reg.maxTokenAgeSeconds,
    identity_endpoint_url: reg.identityEndpointUrl,
    login_url: `https://${shop}/account/login`,
    account_url: `https://${shop}/account`,
    delegated_access: opts.delegatedAccess,
    enabled: true,
    confirm: true,
  };
}
