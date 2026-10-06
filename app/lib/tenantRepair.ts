/**
 * What a PUBLISHED tenant needs, decided from reads only (#3718 — Shopify
 * review 5.1.2). PURE: the reads happen in `app/tenantRepair.server.ts`.
 *
 * afterAuth no longer re-provisions a live tenant (an expiring offline token
 * re-exchanges every hour, and each re-run used to publish a new revision), so
 * the two ways a published row can go wrong on its own must be DETECTED:
 *
 *   • ORPHANED — the platform answered that the stored tenant is gone
 *     (`readiness.state === "orphaned"`, or the meter's `tenantUnreachableAt`).
 *     Our demo store: the app said published, the platform tenant was deleted,
 *     every storefront launch 403'd `tenant_not_found`.
 *   • DOMAINS — the store's storefront domains (read fresh from the Admin API)
 *     include a host the published allowlist does not carry: a custom domain
 *     connected after install, or any tenant provisioned before 0.1.12. A
 *     shopper there is refused by `frame-ancestors`.
 *
 * Either one is repaired by the idempotent provisioning lifecycle (it re-homes
 * the tenant by proof-of-shop and publishes the fresh domains). Nothing else
 * triggers a re-publish, and a failed or unreadable read is never a reason.
 */
import type { RuntimeReadiness } from "./runtimeReadiness";
import { parseStoredDomains, storefrontHosts } from "./storefrontDomains";

export type RepairReason = "orphaned" | "domains";

export interface RepairDecision {
  reason: RepairReason;
  detail: string;
}

/** Fresh storefront hosts the stored allowlist does not carry yet (null fresh = unknown = none). */
export function missingStorefrontHosts(stored: string | null | undefined, fresh: readonly string[] | null | undefined): string[] {
  if (!fresh) return [];
  const have = new Set(parseStoredDomains(stored));
  return storefrontHosts(fresh).filter((host) => !have.has(host));
}

export function publishedTenantRepair(input: {
  readiness: RuntimeReadiness | null;
  tenantUnreachableAt?: Date | string | null;
  storedDomains?: string | null;
  freshHosts?: readonly string[] | null;
}): RepairDecision | null {
  if (input.readiness?.state === "orphaned") {
    return { reason: "orphaned", detail: "the platform no longer resolves this shop's tenant" };
  }
  if (input.tenantUnreachableAt) {
    return { reason: "orphaned", detail: "the meter recorded the tenant as unreachable" };
  }
  const missing = missingStorefrontHosts(input.storedDomains, input.freshHosts);
  if (missing.length) {
    return { reason: "domains", detail: `storefront domain(s) not in the published allowlist: ${missing.join(", ")}` };
  }
  return null;
}

/**
 * One background repair per shop at a time, and at most one per `cooldownMs`:
 * a platform that keeps answering "orphaned" (or a provisioning run that keeps
 * failing) must not turn every admin open, webhook and Home poll into a
 * re-publish.
 */
export function createRepairGate(opts: { cooldownMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { at: number; running: boolean }>();
  return {
    tryStart(shop: string): boolean {
      const last = seen.get(shop);
      if (last && (last.running || now() - last.at < opts.cooldownMs)) return false;
      seen.set(shop, { at: now(), running: true });
      return true;
    },
    finish(shop: string): void {
      seen.set(shop, { at: now(), running: false });
    },
  };
}

/** The tenant-row slice the published check reads. */
export interface PublishedTenantRow {
  shop: string;
  bmaiTenantId: string;
  customDomain?: string | null;
  tenantUnreachableAt?: Date | string | null;
}

export interface PublishedCheckDeps {
  /** `readRuntimeReadiness` bound to the live MCP client (never throws). */
  readReadiness: ((tenantId: string) => Promise<RuntimeReadiness>) | null;
  /** The store's storefront domains from the Admin API (throws = unknown). */
  readFreshHosts: ((shop: string) => Promise<string[]>) | null;
  /** Start the (gated, background) repair. */
  repair: (shop: string, decision: RepairDecision) => void;
}

/**
 * Read → decide → (maybe) repair, for a row that says `published`. Every read is
 * soft: a failure is "unknown", and unknown never repairs. Never throws.
 */
export async function checkPublishedTenant(row: PublishedTenantRow, deps: PublishedCheckDeps): Promise<RepairDecision | null> {
  const [readiness, freshHosts] = await Promise.all([
    deps.readReadiness ? deps.readReadiness(row.bmaiTenantId).catch(() => null) : Promise.resolve(null),
    deps.readFreshHosts ? deps.readFreshHosts(row.shop).catch(() => null) : Promise.resolve(null),
  ]);
  const decision = publishedTenantRepair({
    readiness,
    tenantUnreachableAt: row.tenantUnreachableAt,
    storedDomains: row.customDomain,
    freshHosts,
  });
  if (decision) deps.repair(row.shop, decision);
  return decision;
}
