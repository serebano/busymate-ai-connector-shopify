/**
 * Training core (#2110 grounding) — shared by the install lifecycle, the
 * products webhook re-ingest and the "Re-train on my store" button:
 *
 *   fetch the store snapshot → compress to `knowledge_sources` (kbSnapshot.ts)
 *   → ONE publish_tenant_runtime carrying the SAME launch/embed origins the
 *   lifecycle publishes (a re-train must never drop the origins) → persist the
 *   training state (counts, time, last error) on ShopTenant.
 *
 * Errors are PERSISTED (kbError) and RETURNED — never swallowed — so Home and
 * Store connection show "Training failed: …" instead of a silent empty
 * assistant. Pure: every side effect is injected; `app/lib/ingest.ts` binds the
 * live Admin client, MCP publish and Prisma.
 */
import { buildKnowledgeSources, type KbSnapshot, type KnowledgeBuild, type KnowledgeCounts } from "./kbSnapshot";
import type { PublishOptions } from "./mgmtArgs";

export interface PublishResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** The ShopTenant training columns (prisma/schema.prisma) a training run writes. */
export interface TrainingPatch {
  kbTrainedAt?: Date;
  kbError: string | null;
  kbProducts?: number;
  kbPolicies?: number;
  kbPages?: number;
  kbChars?: number;
  kbTruncated?: boolean;
  kbProductsTotal?: number;
  kbPagesTotal?: number;
}

export interface TrainDeps {
  fetchSnapshot: (shop: string) => Promise<KbSnapshot>;
  publish: (shop: string, tenantId: string, opts: PublishOptions) => Promise<PublishResult>;
  saveTraining: (shop: string, patch: TrainingPatch) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface TrainInput {
  shop: string;
  tenantId: string | null | undefined;
  launchOrigins: string[];
  embedOrigins: string[];
}

export interface TrainOutcome {
  ok: boolean;
  error?: string;
  counts: KnowledgeCounts;
  fetched: KnowledgeCounts;
  totalChars: number;
  truncated: boolean;
  revision?: number;
}

const ZERO: KnowledgeCounts = { products: 0, policies: 0, pages: 0 };

/** The successful-training patch for a build (shared with the install lifecycle). */
export function trainingPatch(build: KnowledgeBuild, at: Date): TrainingPatch {
  return {
    kbTrainedAt: at,
    kbError: null,
    kbProducts: build.counts.products,
    kbPolicies: build.counts.policies,
    kbPages: build.counts.pages,
    kbChars: build.totalChars,
    kbTruncated: build.truncated,
    kbProductsTotal: build.fetched.products,
    kbPagesTotal: build.fetched.pages,
  };
}

/** Publish options for a build: origins always, knowledge only when there is some. */
export function publishOptionsFor(build: KnowledgeBuild | null, origins: { launchOrigins: string[]; embedOrigins: string[] }): PublishOptions {
  return {
    launchOrigins: origins.launchOrigins,
    embedOrigins: origins.embedOrigins,
    ...(build && build.sources.length ? { knowledgeSources: build.sources } : {}),
  };
}

/** Did the edge refuse the publish because of the knowledge payload (vs. auth/preflight)? */
export function isKnowledgeRejection(error: string | undefined | null): boolean {
  return /knowledge_sources/i.test(error ?? "");
}

/**
 * A readable message for anything a fetch can throw. The Shopify library throws a
 * bare `Response` (e.g. a refused token refresh); `String(response)` used to persist
 * "[object Response]" as kbError, which says nothing to a merchant or an operator.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof Response !== "undefined" && err instanceof Response) {
    return `Shopify ${err.status}${err.statusText ? ` ${err.statusText}` : ""}`;
  }
  return String(err);
}

function revisionOf(data: unknown): number | undefined {
  const r = (data as { revision?: unknown } | undefined)?.revision;
  return typeof r === "number" ? r : undefined;
}

export async function trainTenant(input: TrainInput, deps: TrainDeps): Promise<TrainOutcome> {
  const { shop } = input;
  const log = deps.log ?? ((m: string) => console.error(m));
  const now = deps.now ?? (() => new Date());
  if (!input.tenantId) {
    return { ok: false, error: "no provisioned tenant for this shop yet", counts: ZERO, fetched: ZERO, totalChars: 0, truncated: false };
  }

  let snapshot: KbSnapshot;
  try {
    snapshot = await deps.fetchSnapshot(shop);
  } catch (err) {
    const message = errorMessage(err).slice(0, 500);
    log(`[kb] snapshot failed for ${shop}: ${message}`);
    await deps.saveTraining(shop, { kbError: message });
    return { ok: false, error: message, counts: ZERO, fetched: ZERO, totalChars: 0, truncated: false };
  }

  const build = buildKnowledgeSources(snapshot);
  const res = await deps.publish(shop, input.tenantId, publishOptionsFor(build, input));
  if (!res.ok) {
    const message = `publish_tenant_runtime: ${res.error ?? "failed"}`.slice(0, 500);
    log(`[kb] publish failed for ${shop}: ${message}`);
    await deps.saveTraining(shop, { kbError: message });
    return { ok: false, error: message, counts: build.counts, fetched: build.fetched, totalChars: build.totalChars, truncated: build.truncated };
  }

  await deps.saveTraining(shop, trainingPatch(build, now()));
  return { ok: true, counts: build.counts, fetched: build.fetched, totalChars: build.totalChars, truncated: build.truncated, revision: revisionOf(res.data) };
}

// ---- Webhook re-ingest debounce ---------------------------------------------

/**
 * products: catalog webhooks · shop: shop/update · scopes: a scope grant
 * (app/scopes_update) · orders: never re-trains.
 */
export type ReingestReason = "products" | "shop" | "scopes" | "orders";

export interface ReingestScheduler {
  /** Queue a re-train for the shop after a quiet period; a burst coalesces into one run. */
  schedule: (shop: string, reason: ReingestReason) => { scheduled: boolean; reason?: string };
  /** Shops with a pending (not yet run) re-train. */
  pending: () => string[];
  /** Drop a pending re-train (app/uninstalled: stop retraining). True when one was pending. */
  cancel: (shop: string) => boolean;
}

/**
 * Per-shop trailing debounce. Product webhooks arrive in bursts (a bulk edit =
 * hundreds); one re-train after the burst is enough. Orders are NOT knowledge —
 * they are read live through the connector — so an order webhook never re-trains.
 * In-memory by design: a lost timer is healed by the next product change or a
 * manual re-train.
 */
export function createReingestScheduler(opts: {
  run: (shop: string) => Promise<unknown>;
  delayMs?: number;
  onError?: (shop: string, err: unknown) => void;
}): ReingestScheduler {
  const delayMs = opts.delayMs ?? 20_000;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(shop, reason) {
      if (reason === "orders") return { scheduled: false, reason: "orders are read live through the store connection; they are not knowledge" };
      const prev = timers.get(shop);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        timers.delete(shop);
        opts.run(shop).catch((err) => opts.onError?.(shop, err));
      }, delayMs);
      (t as { unref?: () => void }).unref?.();
      timers.set(shop, t);
      return { scheduled: true };
    },
    pending: () => [...timers.keys()],
    cancel(shop) {
      const t = timers.get(shop);
      if (!t) return false;
      clearTimeout(t);
      timers.delete(shop);
      return true;
    },
  };
}
