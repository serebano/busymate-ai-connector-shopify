import prisma from "../db.server";
import { adminForShop } from "../mcp/shopifyAdmin";
import { FREE_PLAN_ID, PLANS, computeUsageReport, planFor, reportableUnitsCeiling, type Plan } from "./plans";
import { freeLimitState, monthlyWindow, type CycleWindow, type FreeLimitState } from "./freeLimit";
import { parseMeterCursor, serializeMeterCursor, type MeterCursor } from "./meterCursor";
import { RESOLUTION_EVENT_HANDLE, createAppEventsClient, usageIdempotencyKey } from "./appEvents";
import { appGidFromEnv, fetchActiveSubscription, type ActiveSubscription } from "./partnerApi";
import { commitCountedResolutions, liveResolutionLedgerDeps, readNewResolutions, type CountedSession } from "./resolutionLedger.server";
import { createMeterOutbox, type PreparedMeterBatch } from "./meterOutbox";

export { PLANS, planFor };
export type { Plan };

/**
 * Two ledgers, never conflated:
 *   - Shopify App Pricing (merchant-facing: plan fee + metered overage) — this file.
 *   - Busymate AI usage_events (internal cost/margin truth) — read via MCP.
 *
 * A "resolution" = a positive-outcome, non-double-billed conversation signal. We
 * read the tenant's new resolutions since `cursor` and report EVERY post-trial
 * resolution of the current billing cycle as ONE App Events billing event
 * (`ai_resolution`, value = units). Shopify's own graduated tiers make the first
 * 38/225/830 units free (the included allowance), so the app must not subtract the
 * allowance itself (docs/BILLING.md "Allowance, cap and trial"). App Pricing has no
 * usage-cap concept, so the cap is enforced here by never reporting a cycle past
 * included + floor(cap / price) units. Resolutions that happened during the free
 * trial are never reported, then or later. The cursor (+ cycle counters) advances
 * after a successful report or a nonbillable batch.
 *
 * The cap is a ceiling on CHARGES, never on the assistant — the widget is NEVER
 * disabled (`widgetEnabled()` is unconditional).
 *
 * TRIGGERS: `POST /api/billing/meter` (secret-gated, for a systemd timer — see
 * app/routes/api.billing.meter.tsx) and opportunistically the Billing page load.
 */
export interface MeterDeps {
  /** Stored billing state for the shop (status + plan drive whether we report). */
  getBilling: (shop: string) => Promise<{ status: string; plan: string; lastMeteredCursor: string | null } | null>;
  /** The Busymate AI tenant id for the shop, or null (not provisioned). */
  getTenantId: (shop: string) => Promise<string | null>;
  /**
   * New resolutions since the cursor (Busymate AI MCP read — no backdoor), or null when unreadable.
   * `occurredAt` (one ISO time per resolution, when the conversation ended) lets the meter leave
   * resolutions from the free trial unbilled; absent ⇒ all are treated as post-trial.
   */
  readResolutions: (tenantId: string, cursor: string | null) => Promise<{ resolutions: number; cursor: string; occurredAt?: string[] } | null>;
  /**
   * The live contract (Partner API): its current billing cycle + the shop GID, or `{ trial }`
   * while the free trial runs (Shopify opens no billing cycle and rejects usage then), or null
   * when it cannot be read / has no cycle for another reason (held, never guessed).
   * `end` / `subscriptionId` are extra, OPTIONAL evidence for the outbox. `trialEndsAt` marks
   * resolutions that ended before it as trial usage. `tier` is Shopify's usage tier for the
   * plan (first `freeUnits` free, then `overageCents`); when present it must match the plan or
   * the batch is held (production always supplies it; test deps may omit it).
   */
  readBillingCycle: (shop: string) => Promise<BillingCycle | { trial: true; trialEndsAt: string } | null>;
  /**
   * Report billable units as an App Events billing event. `beforeCursor` /
   * `afterCursor` (the raw stored `BillingState.lastMeteredCursor` before/after
   * this batch) are extra, OPTIONAL evidence a durable-delivery implementation
   * (the outbox, app/lib/meterOutbox.ts) uses to detect a stale batch and to key
   * a stable idempotency identity across retries — a test/mock deps may ignore them.
   */
  reportUsage: (input: {
    shop: string;
    shopId: string;
    units: number;
    idempotencyKey: string;
    beforeCursor?: string | null;
    afterCursor?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Persist the advanced serialized cursor. */
  saveCursor: (shop: string, raw: string) => Promise<void>;
  /**
   * Free plan (and no plan selected): the shop's current allowance window — the Free contract's
   * Partner API billing cycle when Shopify reports one, else monthly from the install date.
   */
  readFreeCycle: (shop: string) => Promise<CycleWindow>;
  /**
   * Free plan: record on the Busymate AI workspace that the allowance is used until `resetsAt`
   * (reached) or lift that (`set_partner_shop_limit`). Resolves true when the platform recorded it.
   */
  reportLimit: (shop: string, input: { reached: boolean; resetsAt: string | null }) => Promise<boolean>;
}

export interface BillingCycle {
  key: string;
  shopId: string;
  end?: string;
  subscriptionId?: string | null;
  trialEndsAt?: string | null;
  tier?: { freeUnits: number | null; overageCents: number | null };
}

export interface MeterOutcome {
  /** New resolutions counted in this run. */
  metered: number;
  /** Billable units reported to Shopify in this run. */
  reportedUnits: number;
  capped: boolean;
  cursor: string | null;
  error?: string;
  /** Free plan (and no plan selected): the allowance this cycle and whether the team-routing hold is recorded. */
  limit?: FreeLimitState & { held: boolean };
}

const noop = (cursor: string | null, extra: Partial<MeterOutcome> = {}): MeterOutcome => ({
  metered: 0,
  reportedUnits: 0,
  capped: false,
  cursor,
  ...extra,
});

/**
 * Meter one batch for a shop.
 *   - a PAID plan (active): allowance → overage → App Events, clamped to the cap;
 *   - the FREE plan, or NO plan selected yet (inactive/cancelled — Free-plan limits apply until the
 *     merchant chooses, billingGate.ts): count against the 25-resolution monthly allowance and, at
 *     the allowance, record the "conversations go to your team" hold on the workspace
 *     (`meterFree`, docs/BILLING.md "Free plan limit");
 *   - pending / frozen: nothing (the next run after Shopify settles counts the batch).
 * Holds the cursor on a refused batch/report. Concurrent delivery and durable
 * retry after a successful report need a separate serialized delivery contract.
 */
export async function meterShop(shop: string, deps: MeterDeps = liveMeterDeps()): Promise<MeterOutcome> {
  const billing = await deps.getBilling(shop);
  const state = parseMeterCursor(billing?.lastMeteredCursor);
  if (!billing) return noop(state.cursor);
  const paid = billing.status === "active" && planFor(billing.plan).overageCents !== null;
  const onFree = (billing.status === "active" && !paid) || !["active", "pending", "frozen"].includes(billing.status);
  if (!paid && !onFree) return noop(state.cursor);
  const tenantId = await deps.getTenantId(shop);
  if (!tenantId) return noop(state.cursor);

  const usage = await deps.readResolutions(tenantId, state.cursor);
  if (!usage) return noop(state.cursor, { error: "resolutions unreadable" });
  if (!Number.isSafeInteger(usage.resolutions) || usage.resolutions < 0 ||
      typeof usage.cursor !== "string" || usage.cursor.trim().length === 0 ||
      (usage.resolutions > 0 && usage.cursor === state.cursor)) {
    return noop(state.cursor, { error: "invalid resolution batch — held" });
  }
  if (onFree) return meterFree(shop, deps, state, usage);

  const resolutions = usage.resolutions;
  const plan = planFor(billing.plan);
  const keep = { cursor: usage.cursor, cycleKey: state.cycleKey, cycleResolutions: state.cycleResolutions, ...(state.cycleReported !== undefined ? { cycleReported: state.cycleReported } : {}) };
  // Upgraded from a held Free month: lift the hold (the platform already ignores it on a paid
  // plan; this keeps the record honest). Best-effort — never blocks metering.
  if (state.limitHeld) await deps.reportLimit(shop, { reached: false, resetsAt: null }).catch(() => false);

  if (resolutions === 0) {
    await deps.saveCursor(shop, serializeMeterCursor(keep));
    return noop(usage.cursor);
  }

  const cycle = await deps.readBillingCycle(shop);
  if (!cycle) {
    // No readable billing cycle (Partner API down, or Shopify has not opened the first
    // cycle after the trial yet): hold everything — never report blind, never lose them.
    return { metered: resolutions, reportedUnits: 0, capped: false, cursor: state.cursor, error: "no active billing cycle — held" };
  }
  if ("trial" in cycle) {
    // Free trial: these resolutions are free for good. Count them for the merchant's view
    // (cycle key `trial:<end>`, so the first paid cycle starts from 0) and commit them to the
    // ledger, so they are never reported in the first paid cycle either.
    const key = `trial:${cycle.trialEndsAt}`;
    const used = (state.cycleKey === key ? state.cycleResolutions : 0) + resolutions;
    await deps.saveCursor(shop, serializeMeterCursor({ cursor: usage.cursor, cycleKey: key, cycleResolutions: used, cycleReported: 0 }));
    return { metered: resolutions, reportedUnits: 0, capped: false, cursor: usage.cursor };
  }
  if (cycle.tier && (cycle.tier.freeUnits !== plan.includedResolutions || (cycle.tier.overageCents !== plan.overageCents && cycle.tier.overageCents !== 0))) {
    // Shopify's usage tier is not the one this plan promises (Partner pricing edited, or the
    // stored plan is behind the contract): reporting now could charge a wrong amount. Hold.
    return {
      metered: resolutions, reportedUnits: 0, capped: false, cursor: state.cursor,
      error: `Shopify usage tier (first ${cycle.tier.freeUnits ?? "?"} free, then ${cycle.tier.overageCents ?? "?"}¢) does not match the ${plan.name} plan (${plan.includedResolutions} included, then ${plan.overageCents}¢) — held`,
    };
  }
  // Resolutions whose conversation ended before the trial ended are trial usage: never billed.
  const trialEnd = cycle.trialEndsAt ? Date.parse(cycle.trialEndsAt) : NaN;
  const trialUsage = Number.isFinite(trialEnd) && usage.occurredAt
    ? usage.occurredAt.filter((t) => Date.parse(t) < trialEnd).length
    : 0;
  const billable = resolutions - trialUsage;
  const sameCycle = state.cycleKey === cycle.key;
  const cycleResolutions = sameCycle ? state.cycleResolutions : 0;
  // A cursor from before 2026-11-26 has no `cycleReported`. Its in-cycle count may include
  // trial backlog (the old meter counted trial resolutions in the first paid cycle) and none of
  // it was ever reported (no App Events credential in production). Treat that count as settled
  // rather than catch it up: the merchant is never billed for usage we cannot prove billable.
  const reportedBefore = sameCycle ? state.cycleReported ?? Math.min(cycleResolutions, reportableUnitsCeiling(plan)) : 0;
  const { units, capped } = computeUsageReport({ plan, cycleResolutions, reportedBefore, newResolutions: billable });
  const next = serializeMeterCursor({ cursor: usage.cursor, cycleKey: cycle.key, cycleResolutions: cycleResolutions + billable, cycleReported: reportedBefore + units });

  if (units > 0) {
    const rec = await deps.reportUsage({
      shop,
      shopId: cycle.shopId,
      units,
      idempotencyKey: usageIdempotencyKey(shop, usage.cursor),
      beforeCursor: billing.lastMeteredCursor ?? null,
      afterCursor: next,
    });
    if (!rec.ok) {
      // Transient failure — hold the cursor so the batch is retried, not lost.
      return { metered: resolutions, reportedUnits: 0, capped, cursor: state.cursor, error: rec.error };
    }
  }
  await deps.saveCursor(shop, next);
  return { metered: resolutions, reportedUnits: units, capped, cursor: usage.cursor };
}

/**
 * The Free allowance (docs/BILLING.md "Free plan limit"): count this cycle's resolutions (a new
 * cycle starts from 0), and when the count reaches the plan's included resolutions record the
 * hold that sends new shopper conversations to the team until the cycle ends. The hold is
 * re-recorded when a new cycle reaches it again and lifted when the count is back under (a reset).
 * A refused record keeps the previous state so the next run retries it; it never blocks counting.
 */
async function meterFree(shop: string, deps: MeterDeps, state: MeterCursor, usage: { resolutions: number; cursor: string }): Promise<MeterOutcome> {
  const plan = planFor(FREE_PLAN_ID);
  const cycle = await deps.readFreeCycle(shop);
  const used = (state.cycleKey === cycle.key ? state.cycleResolutions : 0) + usage.resolutions;
  const limit = freeLimitState({ included: plan.includedResolutions, used, resetsAt: cycle.end });
  let held = state.limitHeld === true;
  if (limit.reached !== held || (limit.reached && state.cycleEnd !== cycle.end)) {
    const recorded = await deps.reportLimit(shop, { reached: limit.reached, resetsAt: limit.reached ? cycle.end : null }).catch(() => false);
    if (recorded) held = limit.reached;
  }
  await deps.saveCursor(shop, serializeMeterCursor({
    cursor: usage.cursor, cycleKey: cycle.key, cycleResolutions: used,
    cycleEnd: cycle.end, limitHeld: held,
  }));
  return { metered: usage.resolutions, reportedUnits: 0, capped: false, cursor: usage.cursor, limit: { ...limit, held } };
}

/**
 * Live production deps: Prisma + Busymate AI MCP (the resolution ledger) +
 * Partner API + the App Events client, delivered through the durable
 * prepared-batch outbox (app/lib/meterOutbox.ts).
 *
 * `readResolutions` / `readBillingCycle` stash the evidence `reportUsage` needs
 * to build a `PreparedMeterBatch` (tenant, occurrence range, cycle bounds) in
 * closures private to THIS returned object. That is safe because `meterShop`
 * builds a fresh `MeterDeps` per invocation (the `= liveMeterDeps()` default
 * param) and always calls these methods in the same fixed sequence — see the
 * `meterShop` body above. `saveCursor` is where a batch's sessions are finally
 * committed to the idempotent `MeteredResolution` ledger (only paths that
 * reach `saveCursor` are "done"; a held/failed batch is never committed, so it
 * is safely re-derived — usually with the identical evidence — next run).
 */
export function liveMeterDeps(): MeterDeps {
  const events = createAppEventsClient();
  const outbox = createMeterOutbox(prisma);
  const ledgerDeps = liveResolutionLedgerDeps();
  let pending: { tenantId: string; sessions: CountedSession[]; occurredFrom: string | null; occurredThrough: string | null; evidenceRef: string | null } | null = null;
  let plan: string | null = null;
  let status: string | null = null;
  let cycleInfo: { start: string; end: string | null; subscriptionId: string | null } | null = null;

  return {
    getBilling: async (shop) => {
      const b = await prisma.billingState.findUnique({ where: { shop } });
      plan = b?.plan ?? null;
      status = b?.status ?? null;
      return b ? { status: b.status, plan: b.plan, lastMeteredCursor: b.lastMeteredCursor } : null;
    },
    getTenantId: async (shop) => {
      // An uninstalled / deleted shop is not metered (and never gets a limit record).
      const t = await prisma.shopTenant.findUnique({ where: { shop }, select: { bmaiTenantId: true, inactiveAt: true } });
      return t && !t.inactiveAt ? t.bmaiTenantId ?? null : null;
    },
    readResolutions: async (tenantId, _cursor) => {
      // The real producer (#19/#2835): conversation + hand-off MCP events run
      // through the billable-resolution definition, never `get_tenant_usage`
      // (that tool returns tenant entity counts, not resolutions/cursor).
      const batch = await readNewResolutions(tenantId, ledgerDeps);
      if (!batch) return null;
      pending = { tenantId, sessions: batch.sessions, occurredFrom: batch.occurredFrom, occurredThrough: batch.occurredThrough, evidenceRef: batch.evidenceRef };
      return { resolutions: batch.resolutions, cursor: batch.cursor, occurredAt: batch.sessions.map((s) => s.occurredAt) };
    },
    readBillingCycle: async (shop) => {
      const appGid = appGidFromEnv();
      if (!appGid) return null;
      const admin = await adminForShop(shop);
      const data = (await admin.graphql(`#graphql
        query ShopId { shop { id } }`)) as { shop?: { id?: string } };
      const shopId = data.shop?.id;
      if (!shopId) return null;
      const sub = await fetchActiveSubscription({ appGid, shopGid: shopId });
      if (!sub.ok || !sub.subscription) return null;
      const live = sub.subscription;
      if (!live.currentBillingCycle) {
        // Shopify opens no billing cycle during the free trial (and rejects usage then).
        const trialEnd = live.trialEndsAt ? Date.parse(live.trialEndsAt) : NaN;
        return Number.isFinite(trialEnd) && trialEnd > Date.now() ? { trial: true as const, trialEndsAt: live.trialEndsAt! } : null;
      }
      const { startTime, endTime } = live.currentBillingCycle;
      cycleInfo = { start: startTime, end: endTime ?? null, subscriptionId: live.legacySubscriptionId ?? null };
      return { key: startTime, shopId, end: endTime, subscriptionId: cycleInfo.subscriptionId, trialEndsAt: live.trialEndsAt ?? null, tier: usageTierOf(live) };
    },
    reportUsage: async ({ shop, shopId, units, idempotencyKey, beforeCursor, afterCursor }) => {
      const sendDirect = () => events.reportUsage({ shopId, units, idempotencyKey, timestamp: new Date().toISOString() });
      // Full evidence is only available on the live paid-plan path (readResolutions
      // + readBillingCycle both ran and found something to report). Anything less
      // ⇒ a direct call — still correct, just without the outbox's durability.
      if (!pending || !cycleInfo || !plan || !afterCursor) return sendDirect();
      try {
        const nowIso = new Date().toISOString();
        const start = Date.parse(cycleInfo.start);
        const end = cycleInfo.end ? Date.parse(cycleInfo.end) : start + 31 * 24 * 60 * 60 * 1000;
        // Clamp occurrence evidence into [cycleStart, cycleEnd): a conversation can
        // qualify (cross the 24h reopen window) in a LATER cycle than it happened
        // in — that is still honestly "reported in this cycle", not backdated.
        const clamp = (iso: string | null) => new Date(Math.min(Math.max(Date.parse(iso ?? nowIso) || start, start), end - 1)).toISOString();
        const batch: PreparedMeterBatch = {
          shop,
          tenantId: pending.tenantId,
          shopId,
          plan,
          // App Pricing has no legacy AppSubscriptionLineItem id; the cycle start
          // is this plan-period's stable identity (a plan/contract change rolls
          // the cycle too — see docs/METER-OUTBOX.md "known limitation").
          subscriptionId: cycleInfo.subscriptionId ?? cycleInfo.start,
          beforeCursor: beforeCursor ?? null,
          afterCursor,
          units,
          occurredFrom: clamp(pending.occurredFrom),
          occurredThrough: clamp(pending.occurredThrough),
          timestamp: nowIso,
          cycleStart: cycleInfo.start,
          cycleEnd: new Date(end).toISOString(),
          evidenceRef: pending.evidenceRef ?? idempotencyKey,
        };
        const delivery = await outbox.prepare(batch);
        const claimed = await outbox.claim(shop);
        if (!claimed || claimed.id !== delivery.id) {
          return { ok: false, error: "meter delivery claimed by a concurrent run — held for retry" };
        }
        const sent = await sendDirect();
        if (!sent.ok) {
          await outbox.release(claimed.id, claimed.leaseToken!);
          return sent;
        }
        const accepted = await outbox.accept(claimed.id, claimed.leaseToken!);
        if (accepted.state === "reconciliation") {
          return { ok: false, error: "billing state changed mid-delivery — moved to reconciliation (dead-letter), needs manual review" };
        }
        return { ok: true };
      } catch (err) {
        // A stale/invalid prepared batch (snapshot drift, cross-cycle evidence)
        // never blocks the widget — hold and retry, same as any other failure.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    readFreeCycle: async (shop) => {
      // The $0 Free plan is a real App Pricing contract: use its billing cycle when Shopify
      // reports one (so "a month" is the merchant's own billing month) …
      const appGid = appGidFromEnv();
      if (status === "active" && appGid) {
        try {
          const admin = await adminForShop(shop);
          const data = (await admin.graphql(`#graphql
            query ShopId { shop { id } }`)) as { shop?: { id?: string } };
          const sub = data.shop?.id ? await fetchActiveSubscription({ appGid, shopGid: data.shop.id }) : null;
          const c = sub?.ok ? sub.subscription?.currentBillingCycle : null;
          if (c?.startTime && c.endTime && Date.parse(c.endTime) > Date.now()) return { key: c.startTime, end: c.endTime };
        } catch {
          // fall through to the install-anchored month
        }
      }
      // … otherwise (no plan selected yet, or the cycle is unreadable) monthly from the install date.
      const t = await prisma.shopTenant.findUnique({ where: { shop }, select: { createdAt: true } });
      return monthlyWindow(t?.createdAt ?? new Date(), new Date());
    },
    reportLimit: async (shop, input) => {
      const { reportShopLimit } = await import("../bmai.server");
      return reportShopLimit(shop, input);
    },
    saveCursor: async (shop, raw) => {
      await prisma.billingState.update({ where: { shop }, data: { lastMeteredCursor: raw } });
      if (pending) {
        await commitCountedResolutions(pending.tenantId, pending.sessions);
        pending = null;
      }
    },
  };
}

/**
 * Shopify's usage tier for the `ai_resolution` meter of a live contract: the free first tier's
 * size and the per-unit price after it (cents). `freeUnits` is null when the first graduated tier
 * is missing or not free, so the meter holds instead of reporting against an unknown price.
 * Development stores show every amount as 0 ("Free to test"), so `overageCents` may be 0 there.
 */
export function usageTierOf(sub: Pick<ActiveSubscription, "items">): { freeUnits: number | null; overageCents: number | null } {
  const item = sub.items.find((i) => i.handle === RESOLUTION_EVENT_HANDLE && i.price.__typename === "TieredPrice")
    ?? sub.items.find((i) => i.price.__typename === "TieredPrice");
  if (!item || item.price.__typename !== "TieredPrice") return { freeUnits: null, overageCents: null };
  const tiers = [...item.price.tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  const first = tiers[0];
  const rest = tiers.find((t) => t.upTo === null);
  const cents = (v: string | null | undefined) => {
    const n = Number(v);
    return v !== null && v !== undefined && Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const freeUnits = item.price.tiersMode === "GRADUATED" && first?.upTo != null && cents(first.amountPerUnit) === 0 ? first.upTo : null;
  return { freeUnits, overageCents: rest ? cents(rest.amountPerUnit) : null };
}

/** Reconciliation-state (dead-letter) meter deliveries for a shop — surfaced on the Billing page, never silently retried. */
export async function listStuckDeliveries(shop: string): Promise<Array<{ id: string; createdAt: Date }>> {
  return prisma.meterDelivery.findMany({ where: { shop, state: "reconciliation" }, select: { id: true, createdAt: true }, orderBy: { createdAt: "asc" } });
}

/**
 * The customer-facing widget is NEVER disabled by billing — not at the cap, not
 * without a plan. Hard product invariant; a regression here is a bug.
 */
export function widgetEnabled(): true {
  return true;
}
