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
import { trainTenant, type ReingestReason, type TrainOutcome } from "./kbTrain";
import { runtimeOrigins } from "./provision";
import { enqueueWebhookReingest, type ReingestLease } from "./reingestQueue";
import { reingestStore, requestImmediateReingest, saveTrainingForLease } from "./reingestStore.server";
import { shopToSlug } from "./tenantSlug";
import { TRAINING_NOT_STARTED } from "./kbFreshness";

export { buildKbSnapshot } from "./kbFetch";

/** Why a shop must not be re-trained (uninstalled / deleted store), or null. */
export function retrainRefusal(tenant: { provisionState?: string | null; inactiveAt?: Date | null; inactiveReason?: string | null } | null): string | null {
  if (tenant?.inactiveAt) return `shop is inactive (${tenant.inactiveReason ?? "inactive"}) — not re-trained`;
  if (tenant?.provisionState === "suspended") return "app is uninstalled (tenant suspended) — not re-trained";
  return null;
}

/** Re-train the shop NOW: fetch → compress → publish → persist. Never throws for an ingest error. */
export async function retrainNow(shop: string): Promise<TrainOutcome> {
  const lease = await requestImmediateReingest(shop);
  if (!lease) return { ok: false, error: TRAINING_NOT_STARTED, counts: { products: 0, policies: 0, pages: 0 }, fetched: { products: 0, policies: 0, pages: 0 }, totalChars: 0, truncated: false };
  const { runReingestAttempt } = await import("./reingestProcess.server");
  return runReingestAttempt(lease);
}

/**
 * busymate-ai-src#2624 walk — the MERCHANT's re-train (Store connection, and the
 * publish after an Assistant settings save). Right after install or a catalog
 * change the background worker already holds the training lease, and
 * `retrainNow` answered TRAINING_NOT_STARTED — a red "Training is queued, already
 * running, or the shop is inactive" toast on a fresh store. The enqueue inside
 * `retrainNow` has ALREADY recorded this request (the worker runs again after the
 * current pass, so the latest names/catalog are published either way). So: wait
 * (bounded) for the running pass to finish and take the lease ourselves; if it is
 * still busy, report success-in-progress (`queued`), never a failure. An inactive
 * shop is still refused.
 */
export async function retrainForMerchant(
  shop: string,
  opts: { waitMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; train?: (shop: string) => Promise<TrainOutcome>; isInactive?: (shop: string) => Promise<boolean> } = {},
): Promise<TrainOutcome & { queued?: boolean }> {
  const train = opts.train ?? retrainNow;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isInactive = opts.isInactive ?? (async (s: string) => {
    const t = await prisma.shopTenant.findUnique({ where: { shop: s }, select: { inactiveAt: true, provisionState: true } });
    return Boolean(t?.inactiveAt) || t?.provisionState === "suspended";
  });
  const waitMs = opts.waitMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  let out = await train(shop);
  let waited = 0;
  while (!out.ok && out.error === TRAINING_NOT_STARTED && waited < waitMs) {
    if (await isInactive(shop)) return out;
    await sleep(intervalMs);
    waited += intervalMs;
    out = await train(shop);
  }
  if (!out.ok && out.error === TRAINING_NOT_STARTED && !(await isInactive(shop))) {
    return { ...out, ok: true, error: undefined, queued: true };
  }
  return out;
}

/** Only the isolated attempt child calls the actual publisher. */
export async function trainShopUnderLease(shop: string, lease: ReingestLease): Promise<TrainOutcome> {
  const beforePublish = async () => {
    if (shop !== lease.shop || !await reingestStore.owns(lease)) throw new Error("reingest lease lost");
  };
  await beforePublish();
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
      publish: async (s, tenantId, opts) => {
        await beforePublish();
        return publishTenantRuntime(s, tenantId, opts);
      },
      saveTraining: async (_s, patch) => { await saveTrainingForLease(lease, patch); },
      log: (m) => console.error(m),
    },
  );
}

/** Durable webhook entry; never acknowledge a request before its database commit. */
export function cancelReingest(shop: string): Promise<void> {
  return reingestStore.cancel(shop);
}

export function scheduleReingest(shop: string, reason: ReingestReason, webhookId: string): Promise<{ scheduled: boolean; reason?: string }> {
  return enqueueWebhookReingest(reingestStore, { shop, reason, webhookId });
}
