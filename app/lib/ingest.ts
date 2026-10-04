/**
 * Auto-train — the LIVE wiring of the training core (app/lib/kbTrain.ts).
 *
 *   store snapshot (app/lib/kbFetch.ts, Admin GraphQL) → `knowledge_sources`
 *   (app/lib/kbSnapshot.ts) → publish_tenant_runtime via the bmai seam, with the
 *   SAME launch/embed origins the install lifecycle publishes → training state on
 *   ShopTenant (kb* columns).
 *
 * Three callers share it: the install lifecycle (bmai.server binds
 * buildKnowledgeForShop into the lifecycle's single publish), the products
 * webhook (debounced `scheduleReingest`) and the "Re-train on my store" button
 * (`retrainNow`). Errors are persisted + logged, never swallowed.
 */
import prisma from "../db.server";
import { publishTenantRuntime } from "../bmai.server";
import { buildKbSnapshot } from "./kbFetch";
import { createReingestScheduler, trainTenant, type ReingestReason, type TrainOutcome } from "./kbTrain";
import { runtimeOrigins } from "./provision";
import { shopToSlug } from "./tenantSlug";

export { buildKbSnapshot } from "./kbFetch";

/** Why a shop must not be re-trained (uninstalled / deleted store), or null. */
export function retrainRefusal(tenant: { provisionState?: string | null; inactiveAt?: Date | null; inactiveReason?: string | null } | null): string | null {
  if (tenant?.inactiveAt) return `shop is inactive (${tenant.inactiveReason ?? "inactive"}) — not re-trained`;
  if (tenant?.provisionState === "suspended") return "app is uninstalled (tenant suspended) — not re-trained";
  return null;
}

/** Re-train the shop NOW: fetch → compress → publish → persist. Never throws for an ingest error. */
export async function retrainNow(shop: string): Promise<TrainOutcome> {
  const tenant = await prisma.shopTenant.findUnique({ where: { shop } });
  const refusal = retrainRefusal(tenant);
  if (refusal) {
    // Not persisted as kbError: an inactive shop is not a training failure.
    const zero = { products: 0, policies: 0, pages: 0 };
    return { ok: false, error: refusal, counts: zero, fetched: zero, totalChars: 0, truncated: false };
  }
  const slug = tenant?.slug ?? shopToSlug(shop);
  return trainTenant(
    { shop, tenantId: tenant?.bmaiTenantId, ...runtimeOrigins(shop, slug, tenant?.customDomain) },
    {
      fetchSnapshot: buildKbSnapshot,
      publish: (s, tenantId, opts) => publishTenantRuntime(s, tenantId, opts),
      saveTraining: async (s, patch) => {
        await prisma.shopTenant.updateMany({ where: { shop: s }, data: patch });
      },
      log: (m) => console.error(m),
    },
  );
}

const scheduler = createReingestScheduler({
  run: async (shop) => {
    const out = await retrainNow(shop);
    if (out.ok) console.log(`[kb] re-trained ${shop}: ${out.counts.products} products, ${out.counts.policies} policies, ${out.counts.pages} pages${out.truncated ? " (truncated to fit)" : ""}`);
    else console.error(`[kb] re-train failed for ${shop}: ${out.error}`);
  },
  delayMs: Number(process.env.KB_REINGEST_DEBOUNCE_MS) > 0 ? Number(process.env.KB_REINGEST_DEBOUNCE_MS) : 20_000,
  onError: (shop, err) => console.error(`[kb] re-train crashed for ${shop}: ${err instanceof Error ? err.message : String(err)}`),
});

/**
 * Webhook entry: queue a re-train after a quiet period (product webhooks arrive in
 * bursts). Returns immediately so the webhook can 200; the outcome is persisted on
 * ShopTenant (kbTrainedAt / kbError) and logged. Order webhooks never re-train.
 */
export function cancelReingest(shop: string): boolean {
  return scheduler.cancel(shop);
}

export function scheduleReingest(shop: string, reason: ReingestReason): { scheduled: boolean; reason?: string } {
  return scheduler.schedule(shop, reason);
}
