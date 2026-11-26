import { describe, expect, it } from "vitest";
import { meterShop, planFor, widgetEnabled, type MeterDeps } from "../app/lib/usageBilling";
import { parseMeterCursor, serializeMeterCursor } from "../app/lib/meterCursor";

/**
 * Usage metering under Shopify App Pricing. Proves: the plan's INCLUDED allowance
 * is honored (no event inside it), only the overage is reported as App Events
 * (`ai_resolution`, value = units), the app-enforced monthly cap clamps the
 * report, a Free plan / no subscription never reports, the cycle counter resets
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
  cycle?: { key: string } | null;
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
    readResolutions: async () => ({ resolutions: over.resolutions ?? 3, cursor: "c1" }),
    readBillingCycle: async () => (over.cycle === undefined ? { key: "2026-09-01T00:00:00Z", shopId: "gid://shopify/Shop/1" } : over.cycle === null ? null : { key: over.cycle.key, shopId: "gid://shopify/Shop/1" }),
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
  it("inside the included allowance: no event, cursor + cycle counter advance", async () => {
    const h = makeDeps({ resolutions: 10 }); // growth: 225 included
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported).toEqual([]);
    expect(out).toMatchObject({ metered: 10, reportedUnits: 0, capped: false });
    expect(parseMeterCursor(h.saved.at(-1))).toEqual({ cursor: "c1", cycleKey: "2026-09-01T00:00:00Z", cycleResolutions: 10 });
  });

  it("crossing the allowance reports only the overage units with a stable idempotency key", async () => {
    const h = makeDeps({ resolutions: 10, cursor: serializeMeterCursor({ cursor: "c0", cycleKey: "2026-09-01T00:00:00Z", cycleResolutions: 220 }) });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0].units).toBe(5);
    expect(h.reported[0].idempotencyKey.length).toBeLessThanOrEqual(64);
    expect(out).toMatchObject({ metered: 10, reportedUnits: 5, capped: false });
    expect(parseMeterCursor(h.saved.at(-1)).cycleResolutions).toBe(230);
  });

  it("clamps to the plan's monthly overage cap (widget stays on, resolutions still counted)", async () => {
    // growth: $1,000 cap / $0.44 ⇒ 2272 billable units; 2270 already billed
    const h = makeDeps({ resolutions: 50, cursor: serializeMeterCursor({ cursor: "c0", cycleKey: "2026-09-01T00:00:00Z", cycleResolutions: 225 + 2270 }) });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported.map((r) => r.units)).toEqual([2]);
    expect(out.capped).toBe(true);
    expect(parseMeterCursor(h.saved.at(-1)).cycleResolutions).toBe(225 + 2270 + 50);
    expect(widgetEnabled()).toBe(true);
  });

  it("a new billing cycle resets the allowance counter", async () => {
    const h = makeDeps({ resolutions: 10, cursor: serializeMeterCursor({ cursor: "c0", cycleKey: "2026-08-01T00:00:00Z", cycleResolutions: 500 }) });
    const out = await meterShop(SHOP, h.deps);
    expect(h.reported).toEqual([]); // 10 new resolutions in a fresh cycle sit inside 225
    expect(out.reportedUnits).toBe(0);
    expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleKey: "2026-09-01T00:00:00Z", cycleResolutions: 10 });
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
