/**
 * Ops: the tenant RECONCILE sweep (#3718 — Shopify review 5.1.2). Classifies
 * every installed shop (or the named ones) from the same reads Home and
 * afterAuth use — runtime readiness via MCP `get_tenant_integration` (an
 * orphaned tenant is a definite platform answer, repaired with no flag), the
 * store's storefront domains via the Admin API (stored offline session), and
 * frameability via the platform's public `/api/embed-status` for the Online
 * Store, every custom storefront domain AND the Theme Editor chain — and
 * re-runs the idempotent provisioning lifecycle for rows that say `published`
 * while the storefront chat cannot open (orphaned tenant, stuck revision,
 * missing domain, refused chain) and for failed installs. See app/lib/reconcile.ts.
 *
 *   npm run tenants:reconcile -- [--apply] [--reprovision-unverified] [<shop.myshopify.com> ...]
 *
 * DRY-RUN by default: prints one JSON line per shop (verdict + action). With
 * --apply it re-provisions the rows whose action is `reprovision`. Uninstalled
 * (suspended) shops are never touched. Needs the app env (SETUP §3c: source
 * /etc/busymate-ai-shopify/env as root, `sudo -E -H -u deploy`). Value-blind.
 * Exits 1 if any applied re-provision failed.
 */
import prisma from "../app/db.server";
import { callMcpTool, reprovisionShop } from "../app/bmai.server";
import { adminForShop } from "../app/mcp/shopifyAdmin";
import { fetchStorefrontHosts, parseStoredDomains, storefrontHosts } from "../app/lib/storefrontDomains";
import { readRuntimeReadiness } from "../app/lib/runtimeReadiness";
import { readStorefrontFrameable } from "../app/lib/embedFrameable";
import { planReconcile } from "../app/lib/reconcile";
import { shopToSlug } from "../app/lib/tenantSlug";

const PLATFORM_ORIGIN = process.env.BMAI_EMBED_ORIGIN || "https://busymate.ai";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const reprovisionUnverified = args.includes("--reprovision-unverified");
  const shops = args.filter((a) => !a.startsWith("--")).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const rows = await prisma.shopTenant.findMany({
    where: shops.length ? { shop: { in: shops } } : {},
    select: { shop: true, slug: true, provisionState: true, bmaiTenantId: true, tenantUnreachableAt: true, customDomain: true, inactiveAt: true },
    orderBy: { shop: "asc" },
  });
  let failed = 0;
  for (const row of rows) {
    const live = row.provisionState === "published" && row.bmaiTenantId;
    // Soft: an Admin read that fails is "unknown" (null), never a missing domain.
    const freshHosts = live ? await (async () => fetchStorefrontHosts(await adminForShop(row.shop)))().catch(() => null) : null;
    const domains = storefrontHosts([...parseStoredDomains(row.customDomain), ...(freshHosts ?? [])]);
    const [readiness, frameable] = await Promise.all([
      live ? readRuntimeReadiness(row.bmaiTenantId!, callMcpTool) : Promise.resolve(null),
      live ? readStorefrontFrameable({ platformOrigin: PLATFORM_ORIGIN, shop: row.shop, slug: row.slug ?? shopToSlug(row.shop), domains }) : Promise.resolve(null),
    ]);
    const plan = planReconcile(row, { readiness, frameable, freshHosts }, { reprovisionUnverified });
    const line: Record<string, unknown> = { shop: row.shop, verdict: plan.verdict, action: plan.action, reason: plan.reason, frameable, runtime: readiness?.state ?? null, domains };
    if (apply && plan.action === "reprovision") {
      const out = await reprovisionShop(row.shop);
      line.applied = { ok: out.ok, tenantId: out.tenantId, reactivated: out.reactivated, error: out.error ?? null, warnings: out.warnings.length };
      if (!out.ok) failed++;
    }
    console.log(JSON.stringify(line));
  }
  if (!rows.length) console.log(JSON.stringify({ shops: shops.length ? shops : "all", rows: 0 }));
  return failed ? 1 : 0;
}

main().then(
  async (code) => { await prisma.$disconnect(); process.exit(code); },
  async (err) => {
    console.error(`[tenants:reconcile] ${err instanceof Error ? err.message : String(err)}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  },
);
