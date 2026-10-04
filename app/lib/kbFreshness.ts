/**
 * Knowledge freshness (#52) — the pure core of the re-train BACKSTOP and of the
 * freshness HEALTH verdict. Every side effect is injected; the live wiring is
 * app/lib/kbFreshness.server.ts and the host timer runs scripts/kb-freshness.ts.
 *
 * Why a backstop at all: training is event-driven (install, products/*, shop/update,
 * app/scopes_update, "Re-train"), but Shopify has NO webhook for shop policies or
 * pages. A merchant's refund-policy edit would never reach the assistant, and a
 * store with no catalog change for 7 days fails the platform's 168 h
 * `knowledge-citations` launch preflight on every later publish. So:
 *
 *   - re-train any ACTIVE shop whose knowledge is older than RETRAIN_AFTER_HOURS (72 h);
 *   - before training, probe the shop anonymously; a shop Shopify no longer serves
 *     (admin AND storefront answer 404 — a deleted review store) is marked INACTIVE
 *     and never retried, so dead stores do not error-loop;
 *   - jitter + spacing + a per-run cap keep it well inside Shopify's API limits;
 *   - idempotent: a re-train is replace-by-key on the platform, the row is re-read
 *     right before training (a webhook re-train in between makes it not due), and a
 *     run that finds another run in flight steps aside.
 *
 * Health (fail-closed, green-while-dead): RED when any active shop's knowledge is
 * older than ALERT_AFTER_HOURS (96 h) or was never trained, AND when no backstop run
 * has FINISHED within BACKSTOP_MAX_SILENCE_HOURS — the absence of success is itself
 * the alarm, so a dead timer cannot read as "nothing was due".
 */

export const RETRAIN_AFTER_HOURS = 72;
export const ALERT_AFTER_HOURS = 96;
/** The timer fires every 6 h; two missed runs (+ jitter) is a dead scheduler. */
export const BACKSTOP_MAX_SILENCE_HOURS = 14;
/** A run that started this long ago and never finished is presumed dead (not "in flight"). */
export const RUN_LEASE_HOURS = 2;

const HOUR = 3_600_000;

export interface FreshnessRow {
  shop: string;
  provisionState: string | null;
  bmaiTenantId: string | null;
  kbTrainedAt: Date | null;
  inactiveAt: Date | null;
}

/** A shop the assistant is live for: published, provisioned, not marked inactive. */
export function isActive(row: FreshnessRow): boolean {
  return row.provisionState === "published" && Boolean(row.bmaiTenantId) && !row.inactiveAt;
}

export function ageHours(trainedAt: Date | null, now: Date): number | null {
  if (!trainedAt) return null;
  return Math.max(0, (now.getTime() - trainedAt.getTime()) / HOUR);
}

/** Due = active and (never trained, or trained longer ago than the threshold). */
export function isDue(row: FreshnessRow, now: Date, retrainAfterHours = RETRAIN_AFTER_HOURS): boolean {
  if (!isActive(row)) return false;
  const age = ageHours(row.kbTrainedAt, now);
  return age === null || age >= retrainAfterHours;
}

/** Due shops, oldest knowledge first (never-trained first of all). */
export function selectDue(rows: FreshnessRow[], now: Date, retrainAfterHours = RETRAIN_AFTER_HOURS): FreshnessRow[] {
  return rows
    .filter((r) => isDue(r, now, retrainAfterHours))
    .sort((a, b) => (a.kbTrainedAt?.getTime() ?? 0) - (b.kbTrainedAt?.getTime() ?? 0));
}

// ---- reachability -------------------------------------------------------------

/** HTTP status of an anonymous probe, or null when the request itself failed. */
export interface ReachProbe {
  admin: number | null;
  storefront: number | null;
}

export type Reachability = "reachable" | "gone" | "unavailable" | "unknown";

/**
 * Classify an anonymous probe of `https://<shop>/admin/api/<v>/shop.json` and
 * `https://<shop>/`:
 *   - a live shop answers the admin endpoint 401 (no token) and the storefront 2xx/3xx/401;
 *   - a DELETED shop answers 404 on BOTH → "gone" (the only verdict that marks inactive);
 *   - 402 / 423 (frozen, unpaid, locked) → "unavailable": skip this run, retry later;
 *   - anything else (network error, 5xx, one 404 only) → "unknown": never inactivate on doubt.
 */
export function classifyReachability(p: ReachProbe): Reachability {
  if (p.admin === 404 && p.storefront === 404) return "gone";
  if (p.admin === 402 || p.admin === 423 || p.storefront === 402 || p.storefront === 423) return "unavailable";
  if (p.admin === 401 || p.admin === 200 || p.admin === 403) return "reachable";
  return "unknown";
}

// ---- the backstop run -----------------------------------------------------------

export interface RetrainOutcome {
  ok: boolean;
  error?: string;
}

export interface BackstopDeps {
  listTenants: () => Promise<FreshnessRow[]>;
  /** Re-read one row right before training (idempotency: a webhook may have trained it). */
  readTenant: (shop: string) => Promise<FreshnessRow | null>;
  probe: (shop: string) => Promise<ReachProbe>;
  retrain: (shop: string) => Promise<RetrainOutcome>;
  markInactive: (shop: string, reason: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  random?: () => number;
  log?: (line: string) => void;
}

export interface BackstopOptions {
  retrainAfterHours?: number;
  /** Max shops trained per run (rate limit across the whole run). */
  maxPerRun?: number;
  /** Fixed gap between two shops (Shopify API politeness). */
  spacingMs?: number;
  /** Random extra 0..jitterMs before the run and between shops. */
  jitterMs?: number;
  dryRun?: boolean;
}

export type ShopResult = "trained" | "failed" | "inactivated" | "unavailable" | "unknown" | "not-due" | "deferred" | "would-train";

export interface BackstopSummary {
  ok: boolean;
  considered: number;
  active: number;
  due: number;
  trained: number;
  failed: number;
  inactivated: number;
  skipped: number;
  deferred: number;
  results: Array<{ shop: string; result: ShopResult; ageHours: number | null; error?: string }>;
}

export const BACKSTOP_DEFAULTS = Object.freeze({ maxPerRun: 30, spacingMs: 3_000, jitterMs: 2_000 });

export async function runBackstop(deps: BackstopDeps, opts: BackstopOptions = {}): Promise<BackstopSummary> {
  const retrainAfter = opts.retrainAfterHours ?? RETRAIN_AFTER_HOURS;
  const maxPerRun = opts.maxPerRun ?? BACKSTOP_DEFAULTS.maxPerRun;
  const spacingMs = opts.spacingMs ?? BACKSTOP_DEFAULTS.spacingMs;
  const jitterMs = opts.jitterMs ?? BACKSTOP_DEFAULTS.jitterMs;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((l: string) => console.log(l));

  const rows = await deps.listTenants();
  const now0 = deps.now();
  const active = rows.filter(isActive);
  const due = selectDue(rows, now0, retrainAfter);
  const summary: BackstopSummary = {
    ok: true, considered: rows.length, active: active.length, due: due.length,
    trained: 0, failed: 0, inactivated: 0, skipped: 0, deferred: 0, results: [],
  };

  let attempts = 0;
  for (const [i, candidate] of due.entries()) {
    const age = ageHours(candidate.kbTrainedAt, now0);
    if (attempts >= maxPerRun) {
      summary.deferred++;
      summary.results.push({ shop: candidate.shop, result: "deferred", ageHours: age });
      continue;
    }
    if (i > 0 || jitterMs > 0) await deps.sleep((i > 0 ? spacingMs : 0) + Math.floor(random() * jitterMs));

    // Idempotency: a webhook / button re-train may have landed while we waited.
    const fresh = await deps.readTenant(candidate.shop);
    if (!fresh || !isDue(fresh, deps.now(), retrainAfter)) {
      summary.skipped++;
      summary.results.push({ shop: candidate.shop, result: "not-due", ageHours: age });
      continue;
    }

    const reach = classifyReachability(await deps.probe(candidate.shop));
    if (reach === "gone") {
      if (!opts.dryRun) await deps.markInactive(candidate.shop, "shop_not_found");
      summary.inactivated++;
      summary.results.push({ shop: candidate.shop, result: "inactivated", ageHours: age });
      log(`[kb-freshness] ${candidate.shop}: Shopify answers 404 (admin + storefront) — marked inactive, not retried`);
      continue;
    }
    if (reach === "unavailable" || reach === "unknown") {
      summary.skipped++;
      summary.results.push({ shop: candidate.shop, result: reach, ageHours: age });
      log(`[kb-freshness] ${candidate.shop}: reachability ${reach} — skipped this run`);
      continue;
    }

    if (opts.dryRun) {
      summary.results.push({ shop: candidate.shop, result: "would-train", ageHours: age });
      continue;
    }
    attempts++;
    let out: RetrainOutcome;
    try {
      out = await deps.retrain(candidate.shop);
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (out.ok) {
      summary.trained++;
      summary.results.push({ shop: candidate.shop, result: "trained", ageHours: age });
    } else {
      summary.failed++;
      summary.ok = false;
      summary.results.push({ shop: candidate.shop, result: "failed", ageHours: age, error: (out.error ?? "failed").slice(0, 300) });
    }
  }
  log(
    `[kb-freshness] run: considered=${summary.considered} active=${summary.active} due=${summary.due} trained=${summary.trained} ` +
      `failed=${summary.failed} inactivated=${summary.inactivated} skipped=${summary.skipped} deferred=${summary.deferred}`,
  );
  return summary;
}

/** Another run is in flight when one started within the lease and has not finished. */
export function runInFlight(last: { startedAt: Date; finishedAt: Date | null } | null, now: Date): boolean {
  if (!last || last.finishedAt) return false;
  return now.getTime() - last.startedAt.getTime() < RUN_LEASE_HOURS * HOUR;
}

// ---- health -------------------------------------------------------------------

export type HealthVerdict = "green" | "red" | "unverified";

export interface FreshnessHealth {
  verdict: HealthVerdict;
  reasons: string[];
  activeShops: number;
  staleShops: number;
  neverTrained: number;
  oldestAgeHours: number | null;
  lastRunFinishedAt: string | null;
  thresholds: { retrainAfterHours: number; alertAfterHours: number; backstopMaxSilenceHours: number };
  /** Per-shop detail — only for operators (the public endpoint strips it). */
  stale: Array<{ shop: string; ageHours: number | null }>;
}

export function freshnessHealth(
  rows: FreshnessRow[] | null,
  lastFinishedRun: { finishedAt: Date } | null,
  now: Date,
  opts: { alertAfterHours?: number; backstopMaxSilenceHours?: number } = {},
): FreshnessHealth {
  const alertAfter = opts.alertAfterHours ?? ALERT_AFTER_HOURS;
  const maxSilence = opts.backstopMaxSilenceHours ?? BACKSTOP_MAX_SILENCE_HOURS;
  const thresholds = { retrainAfterHours: RETRAIN_AFTER_HOURS, alertAfterHours: alertAfter, backstopMaxSilenceHours: maxSilence };
  if (!rows) {
    return {
      verdict: "unverified", reasons: ["the tenant table could not be read — freshness is UNKNOWN, not fine"],
      activeShops: 0, staleShops: 0, neverTrained: 0, oldestAgeHours: null, lastRunFinishedAt: null, thresholds, stale: [],
    };
  }
  const active = rows.filter(isActive);
  const ages = active.map((r) => ({ shop: r.shop, ageHours: ageHours(r.kbTrainedAt, now) }));
  const stale = ages.filter((a) => a.ageHours === null || a.ageHours > alertAfter);
  const known = ages.map((a) => a.ageHours).filter((a): a is number => a !== null);
  const reasons: string[] = [];
  if (stale.length) {
    reasons.push(`${stale.length} of ${active.length} active shop(s) have knowledge older than ${alertAfter} h or never trained`);
  }
  const lastAt = lastFinishedRun?.finishedAt ?? null;
  if (!lastAt) reasons.push("no knowledge-freshness backstop run has ever finished");
  else if ((now.getTime() - lastAt.getTime()) / HOUR > maxSilence) {
    reasons.push(`the last backstop run finished ${Math.round((now.getTime() - lastAt.getTime()) / HOUR)} h ago (limit ${maxSilence} h) — the timer is not running`);
  }
  return {
    verdict: reasons.length ? "red" : "green",
    reasons,
    activeShops: active.length,
    staleShops: stale.length,
    neverTrained: ages.filter((a) => a.ageHours === null).length,
    oldestAgeHours: known.length ? Math.round(Math.max(...known) * 10) / 10 : null,
    lastRunFinishedAt: lastAt ? lastAt.toISOString() : null,
    thresholds,
    stale: stale.map((s) => ({ shop: s.shop, ageHours: s.ageHours === null ? null : Math.round(s.ageHours * 10) / 10 })),
  };
}
