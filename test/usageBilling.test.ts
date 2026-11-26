import { describe, expect, it } from "vitest";
import { meterShop, planFor, usageTierOf, widgetEnabled, type BillingCycle, type MeterDeps } from "../app/lib/usageBilling";
import { parseMeterCursor, serializeMeterCursor } from "../app/lib/meterCursor";

/**
 * Usage metering under Shopify App Pricing. Proves: every post-trial resolution is
 * reported as App Events (`ai_resolution`, value = units) because Shopify's own
 * free first tier is the included allowance, the app-enforced monthly cap clamps
 * the cycle total, trial usage is never billed (during or after the trial), a
 * mismatched Shopify tier holds the batch, a Free plan / no subscription never reports, the cycle counter resets
 * on a new billing cycle, the cursor holds on a transient failure, and the hard
 * invariant that the widget is never disabled by billing.
 */
const SHOP = "acme.myshopify.com";
const FREE_CYCLE = { key: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" };

interface Harness {
  deps: MeterDeps;
  reported: Array<{ units: number; idempotencyKey: string }>;
  saved: string[];
  limits: Array<{ reached: boolean; resetsAt: string | null }>;
}

function makeDeps(over: {
  plan?: string;
  status?: string;
  cursor?: string | null;
  resolutions?: number;
  cycle?: BillingCycle | { trial: true; trialEndsAt: string } | null;
  occurredAt?: string[];
  nextCursor?: string;
  reportOk?: boolean;
  tenant?: string | null;
  freeCycle?: { key: string; end: string };
  limitOk?: boolean;
} = {}): Harness {
  const reported: Harness["reported"] = [];
  const saved: string[] = [];
  const limits: Harness["limits"] = [];
  const deps: MeterDeps = {
    getBilling: async () => ({ status: over.status ?? "active", plan: over.plan ?? "growth", lastMeteredCursor: over.cursor === undefined ? "c0" : over.cursor }),
    getTenantId: async () => (over.tenant === undefined ? "t_1" : over.tenant),
    readResolutions: async () => ({ resolutions: over.resolutions ?? 3, cursor: over.nextCursor ?? "c1", ...(over.occurredAt ? { occurredAt: over.occurredAt } : {}) }),
    readBillingCycle: async () => (over.cycle === undefined ? { key: "2026-09-01T00:00:00Z", shopId: "gid://shopify/Shop/1" } : over.cycle),
    reportUsage: async ({ units, idempotencyKey }) => {
      reported.push({ units, idempotencyKey });
      return over.reportOk === false ? { ok: false, error: "App Events 503" } : { ok: true };
    },
    saveCursor: async (_shop, raw) => {
      saved.push(raw);
    },
    readFreeCycle: async () => over.freeCycle ?? FREE_CYCLE,
    reportLimit: async (_shop, input) => {
      limits.push(input);
      return over.limitOk !== false;
    },
  };
  return { deps, reported, saved, limits };
}

describe("meterShop (App Pricing usage events)", () => {
  const CYCLE = "2026-09-01T00:00:00Z";
  const cur = (n: number, reported: number, key = CYCLE) => serializeMeterCursor({ cursor: "c0", cycleKey: key, cycleResolutions: n, cycleReported: reported });

  it("inside the allowance every resolution is still reported: Shopify's free first tier applies the allowance", async () => {
    const h = makeDeps({ resolutions: 10 }); // growth: Shopify tier "first 225 free"
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported.map((r) => r.units)).toEqual([10]);
    expect(out).toMatchObject({ metered: 10, reportedUnits: 10, capped: false });
    expect(parseMeterCursor(h.saved.at(-1))).toEqual({ cursor: "c1", cycleKey: CYCLE, cycleResolutions: 10, cycleReported: 10 });
  });

  it("Starter end to end: 38 reported free, the 39th reported → Shopify quantity 39 = one $0.49 charge", async () => {
    const a = makeDeps({ plan: "starter", resolutions: 38, cursor: null });
    await meterShop(SHOP, a.deps);
    const b = makeDeps({ plan: "starter", resolutions: 1, cursor: a.saved.at(-1)!, nextCursor: "c2" });
    const out = await meterShop(SHOP, b.deps);
    expect([...a.reported, ...b.reported].map((r) => r.units)).toEqual([38, 1]);
    expect(out.reportedUnits).toBe(1);
    expect(parseMeterCursor(b.saved.at(-1))).toMatchObject({ cycleResolutions: 39, cycleReported: 39 });
    expect(b.reported[0].idempotencyKey.length).toBeLessThanOrEqual(64);
  });

  it("clamps the cycle total at the cap ceiling (Growth 225 + 2272 = 2497 units → $999.68), widget stays on", async () => {
    const h = makeDeps({ resolutions: 50, cursor: cur(2495, 2495) });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported.map((r) => r.units)).toEqual([2]);
    expect(out.capped).toBe(true);
    expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleResolutions: 2545, cycleReported: 2497 });
    const after = makeDeps({ resolutions: 7, cursor: h.saved.at(-1)!, nextCursor: "c2" });
    expect((await meterShop(SHOP, after.deps)).reportedUnits).toBe(0);
    expect(after.reported).toEqual([]);
    expect(widgetEnabled()).toBe(true);
  });

  it("a new billing cycle resets both counters", async () => {
    const h = makeDeps({ resolutions: 10, cursor: cur(500, 500, "2026-08-01T00:00:00Z") });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported.map((r) => r.units)).toEqual([10]);
    expect(out.reportedUnits).toBe(10);
    expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleKey: CYCLE, cycleResolutions: 10, cycleReported: 10 });
  });

  it("a pre-fix cursor (no cycleReported) treats its in-cycle count as settled — no catch-up of possible trial backlog", async () => {
    const legacy = serializeMeterCursor({ cursor: "c0", cycleKey: CYCLE, cycleResolutions: 37 });
    const h = makeDeps({ plan: "starter", resolutions: 5, cursor: legacy });
    await meterShop(SHOP, h.deps);
    expect(h.reported.map((r) => r.units)).toEqual([5]);
    expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleResolutions: 42, cycleReported: 42 });
  });

  describe("free trial: never billed, now or in the first paid cycle", () => {
    const TRIAL_END = "2026-10-23T17:36:35Z";

    it("during the trial: counted for display under a trial key, committed, nothing reported", async () => {
      const h = makeDeps({ plan: "starter", resolutions: 12, cycle: { trial: true, trialEndsAt: TRIAL_END } });
      const out = await meterShop(SHOP, h.deps);
      expect(h.reported).toEqual([]);
      expect(out).toMatchObject({ metered: 12, reportedUnits: 0, cursor: "c1" });
      expect(out.error).toBeUndefined();
      expect(parseMeterCursor(h.saved.at(-1))).toEqual({ cursor: "c1", cycleKey: `trial:${TRIAL_END}`, cycleResolutions: 12, cycleReported: 0 });
    });

    it("first paid cycle: resolutions that ended during the trial are dropped, the rest start from 0", async () => {
      const trialCursor = serializeMeterCursor({ cursor: "c0", cycleKey: `trial:${TRIAL_END}`, cycleResolutions: 12, cycleReported: 0 });
      const h = makeDeps({
        plan: "starter", resolutions: 5, cursor: trialCursor,
        // 3 conversations ended during the trial but only became decidable (24 h idle) after it.
        occurredAt: ["2026-10-22T10:00:00Z", "2026-10-23T09:00:00Z", "2026-10-23T17:36:34Z", "2026-10-23T17:36:35Z", "2026-10-25T08:00:00Z"],
        cycle: { key: TRIAL_END, shopId: "gid://shopify/Shop/1", end: "2026-11-22T17:36:35Z", trialEndsAt: TRIAL_END },
      });
      const out = await meterShop(SHOP, h.deps);
      expect(h.reported.map((r) => r.units)).toEqual([2]);
      expect(out).toMatchObject({ metered: 5, reportedUnits: 2 });
      expect(parseMeterCursor(h.saved.at(-1))).toEqual({ cursor: "c1", cycleKey: TRIAL_END, cycleResolutions: 2, cycleReported: 2 });
    });

    it("a batch made only of trial resolutions reports nothing and still commits", async () => {
      const h = makeDeps({
        plan: "starter", resolutions: 2, occurredAt: ["2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"],
        cycle: { key: TRIAL_END, shopId: "gid://shopify/Shop/1", trialEndsAt: TRIAL_END },
      });
      const out = await meterShop(SHOP, h.deps);
      expect(h.reported).toEqual([]);
      expect(out).toMatchObject({ metered: 2, reportedUnits: 0, cursor: "c1" });
      expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleKey: TRIAL_END, cycleResolutions: 0, cycleReported: 0 });
    });
  });

  describe("Shopify's live usage tier must match the plan", () => {
    const base = { key: CYCLE, shopId: "gid://shopify/Shop/1" };
    it("matching tier (Starter: first 38 free, then 49¢) reports", async () => {
      const h = makeDeps({ plan: "starter", resolutions: 4, cycle: { ...base, tier: { freeUnits: 38, overageCents: 49 } } });
      expect((await meterShop(SHOP, h.deps)).reportedUnits).toBe(4);
    });
    it("a development store's zeroed price (\"Free to test\") still matches", async () => {
      const h = makeDeps({ plan: "starter", resolutions: 4, cycle: { ...base, tier: { freeUnits: 38, overageCents: 0 } } });
      expect((await meterShop(SHOP, h.deps)).reportedUnits).toBe(4);
    });
    it("a different free tier, price or unknown tier holds the batch (nothing reported, nothing saved)", async () => {
      for (const tier of [{ freeUnits: 225, overageCents: 49 }, { freeUnits: 38, overageCents: 44 }, { freeUnits: null, overageCents: null }]) {
        const h = makeDeps({ plan: "starter", resolutions: 4, cycle: { ...base, tier } });
        const out = await meterShop(SHOP, h.deps);
        expect(out.reportedUnits).toBe(0);
        expect(out.error).toMatch(/does not match the Starter plan.*held/);
        expect(h.reported).toEqual([]);
        expect(h.saved).toEqual([]);
      }
    });
    it("usageTierOf reads the live Partner API shape (tiers listed open-ended first, as Shopify returns them)", () => {
      const live = { items: [
        { handle: "starter", description: "Starter", price: { __typename: "FlatRatePrice" as const, active: false, currency: "USD", amount: "19.0" }, usage: null },
        { handle: "ai_resolution", description: "AI resolution", price: { __typename: "TieredPrice" as const, active: false, currency: "USD", tiersMode: "GRADUATED" as const,
          tiers: [{ upTo: null, amountPerUnit: "0.49", amount: "0.0" }, { upTo: 38, amountPerUnit: "0.0", amount: "0.0" }] }, usage: null },
      ] };
      expect(usageTierOf(live)).toEqual({ freeUnits: 38, overageCents: 49 });
      const notFree = { items: [{ ...live.items[1], price: { ...live.items[1].price, tiers: [{ upTo: 38, amountPerUnit: "0.10", amount: "0.0" }, { upTo: null, amountPerUnit: "0.49", amount: "0.0" }] } }] };
      expect(usageTierOf(notFree as typeof live)).toEqual({ freeUnits: null, overageCents: 49 });
      expect(usageTierOf({ items: [live.items[0]] })).toEqual({ freeUnits: null, overageCents: null });
    });
  });

  it("the Free plan counts but never reports usage", async () => {
    const h = makeDeps({ plan: "free", resolutions: 100 });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported).toEqual([]);
    expect(out).toMatchObject({ metered: 100, reportedUnits: 0 });
    expect(parseMeterCursor(h.saved.at(-1)).cycleResolutions).toBe(100);
  });

  it("no plan selected yet (inactive) ⇒ Free-plan limits apply: counted, never reported to Shopify", async () => {
    const h = makeDeps({ status: "inactive", resolutions: 10 });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported).toEqual([]);
    expect(out.metered).toBe(10);
    expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleKey: FREE_CYCLE.key, cycleResolutions: 10 });
    expect(h.limits).toEqual([]);
  });

  it("pending / frozen ⇒ nothing counted yet, cursor untouched", async () => {
    for (const status of ["pending", "frozen"]) {
      const h = makeDeps({ status, resolutions: 10 });
      expect((await meterShop(SHOP, h.deps)).metered).toBe(0);
      expect(h.saved).toEqual([]);
    }
  });

  describe("Free plan limit (25, then conversations route to your team)", () => {
    const at = (n: number, extra: Record<string, unknown> = {}) =>
      serializeMeterCursor({ cursor: "c0", cycleKey: FREE_CYCLE.key, cycleResolutions: n, cycleEnd: FREE_CYCLE.end, ...extra });

    it("reaching 25 records the hold until the cycle end, once", async () => {
      const h = makeDeps({ plan: "free", resolutions: 3, cursor: at(23) });
      const out = await meterShop(SHOP, h.deps);
      expect(h.limits).toEqual([{ reached: true, resetsAt: FREE_CYCLE.end }]);
      expect(out.limit).toEqual({ reached: true, used: 26, included: 25, resetsAt: FREE_CYCLE.end, held: true });
      expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleResolutions: 26, limitHeld: true, cycleEnd: FREE_CYCLE.end });
      const again = makeDeps({ plan: "free", resolutions: 2, cursor: h.saved.at(-1)! });
      await meterShop(SHOP, again.deps);
      expect(again.limits).toEqual([]);
    });

    it("under the allowance nothing is recorded", async () => {
      const h = makeDeps({ plan: "free", resolutions: 2, cursor: at(10) });
      expect((await meterShop(SHOP, h.deps)).limit).toMatchObject({ reached: false, used: 12, held: false });
      expect(h.limits).toEqual([]);
    });

    it("a refused record is retried on the next run (never marked held)", async () => {
      const h = makeDeps({ plan: "free", resolutions: 5, cursor: at(24), limitOk: false });
      expect((await meterShop(SHOP, h.deps)).limit?.held).toBe(false);
      const retry = makeDeps({ plan: "free", resolutions: 0, cursor: h.saved.at(-1)! });
      await meterShop(SHOP, retry.deps);
      expect(retry.limits).toEqual([{ reached: true, resetsAt: FREE_CYCLE.end }]);
    });

    it("a new cycle resets the count and lifts the hold, even with no new resolutions", async () => {
      const next = { key: "2026-12-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" };
      const h = makeDeps({ plan: "free", resolutions: 0, cursor: at(30, { limitHeld: true }), freeCycle: next });
      const out = await meterShop(SHOP, h.deps);
      expect(h.limits).toEqual([{ reached: false, resetsAt: null }]);
      expect(out.limit).toMatchObject({ reached: false, used: 0, held: false });
      expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleKey: next.key, cycleResolutions: 0 });
      expect(parseMeterCursor(h.saved.at(-1)).limitHeld).toBeUndefined();
    });

    it("upgrading to a paid plan lifts a held Free month", async () => {
      const h = makeDeps({ plan: "growth", resolutions: 1, cursor: at(30, { limitHeld: true }) });
      await meterShop(SHOP, h.deps);
      expect(h.limits).toEqual([{ reached: false, resetsAt: null }]);
    });

    it("the widget is still never disabled", () => {
      expect(widgetEnabled()).toBe(true);
    });
  });

  it("no active billing cycle (trial or Partner API unreachable) ⇒ hold, never charge blind", async () => {
    const h = makeDeps({ resolutions: 300, cycle: null });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(out.error).toMatch(/billing cycle/);
  });

  it("holds the cursor on a transient App Events failure (no resolution is lost or double-billed)", async () => {
    const h = makeDeps({ resolutions: 10, reportOk: false, cursor: serializeMeterCursor({ cursor: "c0", cycleKey: "2026-09-01T00:00:00Z", cycleResolutions: 220 }) });
    const out = await meterShop(SHOP, h.deps);
    expect(out.error).toMatch(/503/);
    expect(h.saved).toEqual([]);
  });

  it("zero new resolutions advances the cursor without reporting", async () => {
    const h = makeDeps({ resolutions: 0 });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported).toEqual([]);
    expect(out.metered).toBe(0);
    expect(parseMeterCursor(h.saved.at(-1)).cursor).toBe("c1");
  });

  it("not provisioned ⇒ no-op", async () => {
    const h = makeDeps({ tenant: null });
    expect((await meterShop(SHOP, h.deps)).metered).toBe(0);
  });

  it("planFor exposes the catalog overage (scale = $0.42)", () => {
    expect(planFor("scale").overageCents).toBe(42);
  });
});


describe("resolution batch validation", () => {
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, null, "3"])("holds invalid count %s without reporting or saving", async (resolutions) => {
    const h = makeDeps();
    h.deps.readResolutions = async () => ({ resolutions: resolutions as number, cursor: "c1" });
    expect(await meterShop(SHOP, h.deps)).toMatchObject({ error: "invalid resolution batch — held", cursor: "c0", metered: 0 });
    expect(h.reported).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it.each(["", "   ", "c0", null, 123])("holds positive usage with unusable cursor %s", async (cursor) => {
    const h = makeDeps({ resolutions: 500 });
    h.deps.readResolutions = async () => ({ resolutions: 500, cursor: cursor as string });
    expect((await meterShop(SHOP, h.deps)).error).toBe("invalid resolution batch — held");
    expect(h.reported).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it("accepts an empty batch at the current opaque cursor", async () => {
    const h = makeDeps();
    h.deps.readResolutions = async () => ({ resolutions: 0, cursor: "c0" });
    expect(await meterShop(SHOP, h.deps)).toMatchObject({ cursor: "c0", metered: 0 });
    expect(h.reported).toEqual([]);
    expect(parseMeterCursor(h.saved[0]).cursor).toBe("c0");
  });
});
