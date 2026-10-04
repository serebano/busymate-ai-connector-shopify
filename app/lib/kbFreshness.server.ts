/**
 * Live wiring of the knowledge-freshness backstop + health (#52). The decisions
 * live in app/lib/kbFreshness.ts (pure, unit-tested); this binds Prisma, the
 * anonymous Shopify reachability probe and the app's ONE training path
 * (`retrainNow`, app/lib/ingest.ts — the same function the webhooks and the
 * "Re-train" button use).
 */
import prisma from "../db.server";
import { retrainNow } from "./ingest";
import {
  freshnessHealth, runBackstop, runInFlight,
  type BackstopOptions, type BackstopSummary, type FreshnessHealth, type FreshnessRow, type ReachProbe,
} from "./kbFreshness";

const ROW_SELECT = { shop: true, provisionState: true, bmaiTenantId: true, kbTrainedAt: true, inactiveAt: true } as const;
const PROBE_TIMEOUT_MS = 10_000;

async function statusOf(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Anonymous, credential-free reachability: no token is sent, so a live shop's
 * admin answers 401 and a deleted shop's answers 404. Never touches the offline
 * session (a dead shop's refresh would only fail and log).
 */
export async function probeShop(shop: string): Promise<ReachProbe> {
  const version = process.env.SHOPIFY_API_VERSION || "2026-07";
  const [admin, storefront] = await Promise.all([
    statusOf(`https://${shop}/admin/api/${version}/shop.json`),
    statusOf(`https://${shop}/`),
  ]);
  return { admin, storefront };
}

export async function listFreshnessRows(): Promise<FreshnessRow[]> {
  return prisma.shopTenant.findMany({ select: ROW_SELECT, orderBy: { shop: "asc" } });
}

export async function markShopInactive(shop: string, reason: string): Promise<void> {
  await prisma.shopTenant.updateMany({ where: { shop, inactiveAt: null }, data: { inactiveAt: new Date(), inactiveReason: reason } });
}

export interface LedgeredRun {
  runId: string | null;
  skipped?: string;
  summary?: BackstopSummary;
}

/** One backstop run, logged in the KbFreshnessRun ledger with its counts. */
export async function runFreshnessBackstop(opts: BackstopOptions & { trigger?: string } = {}): Promise<LedgeredRun> {
  const now = new Date();
  const last = await prisma.kbFreshnessRun.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true, finishedAt: true } });
  if (runInFlight(last, now)) return { runId: null, skipped: "another backstop run is in flight" };
  if (opts.dryRun) {
    return { runId: null, summary: await runBackstop(backstopDeps(), opts) };
  }
  const run = await prisma.kbFreshnessRun.create({ data: { trigger: opts.trigger ?? "timer" }, select: { id: true } });
  let summary: BackstopSummary;
  try {
    summary = await runBackstop(backstopDeps(), opts);
  } catch (err) {
    // The run did not complete: leave ok=false + finishedAt so the lease frees, but the
    // health check's "last FINISHED run" only counts ok rows, so this is not success.
    await prisma.kbFreshnessRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, detail: { error: err instanceof Error ? err.message : String(err) } },
    });
    throw err;
  }
  await prisma.kbFreshnessRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      // "ok" = the sweep completed; per-shop training failures are counted (and the
      // 96 h shop check alarms on them), they do not erase the evidence the timer ran.
      ok: true,
      considered: summary.considered, active: summary.active, due: summary.due, trained: summary.trained,
      failed: summary.failed, inactivated: summary.inactivated, skipped: summary.skipped, deferred: summary.deferred,
      detail: { results: summary.results },
    },
  });
  return { runId: run.id, summary };
}

function backstopDeps() {
  return {
    listTenants: listFreshnessRows,
    readTenant: (shop: string) => prisma.shopTenant.findUnique({ where: { shop }, select: ROW_SELECT }),
    probe: probeShop,
    retrain: async (shop: string) => {
      const out = await retrainNow(shop);
      return { ok: out.ok, error: out.error };
    },
    markInactive: markShopInactive,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}

/** The health verdict; a DB read failure is UNVERIFIED (fail-closed), never green. */
export async function readFreshnessHealth(now = new Date()): Promise<FreshnessHealth> {
  try {
    const [rows, lastOk] = await Promise.all([
      listFreshnessRows(),
      prisma.kbFreshnessRun.findFirst({ where: { ok: true, finishedAt: { not: null } }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true } }),
    ]);
    return freshnessHealth(rows, lastOk?.finishedAt ? { finishedAt: lastOk.finishedAt } : null, now);
  } catch {
    return freshnessHealth(null, null, now);
  }
}
