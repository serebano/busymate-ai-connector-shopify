/**
 * The tenant RECONCILE sweep (#3718 — Shopify review 5.1.2).
 *
 * The app's own row can say `published` while the storefront chat cannot open:
 *   • ORPHANED — the platform no longer resolves the tenant (our demo store:
 *     `bmaiTenantId` 8fdb70ee… gone, launch 403 `tenant_not_found`). Detected
 *     from the platform's own answer (`readiness.state === "orphaned"`) or the
 *     meter's `tenantUnreachableAt` — repaired WITHOUT any flag;
 *   • STUCK — the published revision failed to activate (the review store's
 *     reinstall deadlock: `runtime.state = error`);
 *   • DOMAINS MISSING — the store has a storefront domain (a custom domain
 *     connected after install, or any row provisioned before 0.1.12) that the
 *     published allowlist does not carry;
 *   • LIVE BUT NOT FRAMEABLE — the platform refuses the storefront, a custom
 *     domain, or the Theme Editor chain.
 * This classifies every row from the same reads Home and afterAuth use (runtime
 * readiness via MCP, the store's domains via the Admin API, frameability via the
 * public embed-status answer) and names ONE action: re-run the idempotent
 * provisioning lifecycle, or nothing.
 *
 * PURE. The script (`scripts/reconcile-tenants.ts`) does the I/O and applies
 * only with `--apply`; uninstalled (suspended) shops are never touched.
 */
import type { RuntimeReadiness } from "./runtimeReadiness";
import type { Frameable } from "./embedFrameable";
import { publishedTenantRepair } from "./tenantRepair";

export interface ReconcileRow {
  shop: string;
  provisionState: string | null;
  bmaiTenantId: string | null;
  tenantUnreachableAt: Date | string | null;
  /** The stored storefront domains (comma-separated), as published. */
  customDomain?: string | null;
  /** #52 — set for an uninstalled or deleted (Shopify 404) store: never touched. */
  inactiveAt?: Date | string | null;
}

export type ReconcileVerdict =
  | "live"
  | "activating"
  | "stuck"
  | "orphaned"
  | "domains-missing"
  | "not-frameable"
  | "failed-install"
  | "uninstalled"
  | "inactive"
  | "unverified"
  | "not-published";

export interface ReconcilePlan {
  verdict: ReconcileVerdict;
  action: "none" | "reprovision";
  reason: string;
}

export interface ReconcileReads {
  readiness: RuntimeReadiness | null;
  /** Online Store + custom domains + Theme Editor chain, folded. */
  frameable: Frameable;
  /** The store's storefront domains read now (null = could not read). */
  freshHosts?: readonly string[] | null;
}

export function planReconcile(
  row: ReconcileRow,
  reads: ReconcileReads,
  opts: { reprovisionUnverified?: boolean } = {},
): ReconcilePlan {
  if (row.provisionState === "suspended") return { verdict: "uninstalled", action: "none", reason: "the app is uninstalled — never touched" };
  if (row.inactiveAt) return { verdict: "inactive", action: "none", reason: "the store is inactive (uninstalled or deleted on Shopify) — never touched" };
  if (row.provisionState === "error") return { verdict: "failed-install", action: "reprovision", reason: "the last provisioning run failed" };
  if (row.provisionState !== "published" || !row.bmaiTenantId) return { verdict: "not-published", action: "none", reason: `provisionState=${row.provisionState ?? "none"}` };
  const repair = publishedTenantRepair({
    readiness: reads.readiness,
    tenantUnreachableAt: row.tenantUnreachableAt,
    storedDomains: row.customDomain,
    freshHosts: reads.freshHosts,
  });
  if (repair?.reason === "orphaned") return { verdict: "orphaned", action: "reprovision", reason: repair.detail };
  const state = reads.readiness?.state ?? "unverified";
  if (state === "error") return { verdict: "stuck", action: "reprovision", reason: "the published revision failed to activate" };
  if (state === "pending") return { verdict: "activating", action: "none", reason: "the published revision is still activating" };
  if (state === "unverified") {
    return opts.reprovisionUnverified
      ? { verdict: "unverified", action: "reprovision", reason: "the tenant could not be read (forced re-provision)" }
      : { verdict: "unverified", action: "none", reason: "the tenant could not be read (a timeout or platform error, not a missing tenant) — re-run later, or with --reprovision-unverified" };
  }
  if (repair?.reason === "domains") return { verdict: "domains-missing", action: "reprovision", reason: repair.detail };
  if (reads.frameable === false) return { verdict: "not-frameable", action: "reprovision", reason: "live, but the storefront, a custom domain or the Theme Editor chain is refused" };
  return { verdict: "live", action: "none", reason: reads.frameable === null ? "live (frameability not answered)" : "live and frameable" };
}
