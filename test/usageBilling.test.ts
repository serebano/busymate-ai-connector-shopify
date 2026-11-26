import { describe, expect, it } from "vitest";
import { CYCLE_CLOSE_GUARD_MS, meterShop, planFor, sameCycleKey, usageTierOf, widgetEnabled, type BillingCycle, type MeterDeps, type MeterWatch } from "../app/lib/usageBilling";
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
    now: () => Date.parse("2026-10-25T00:00:00Z"), // fixed clock, inside every fixture cycle
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
      expect(parseMeterCursor(h.saved.at(-1))).toEqual({ cursor: "c1", cycleKey: `trial:${TRIAL_END}`, cycleResolutions: 12, cycleReported: 0, trialEnd: TRIAL_END });
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
      expect(parseMeterCursor(h.saved.at(-1))).toEqual({ cursor: "c1", cycleKey: TRIAL_END, cycleResolutions: 2, cycleReported: 2, trialEnd: TRIAL_END });
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

  describe("lost reply: reporting is idempotent and reconciles with Shopify's quantity (never counted twice)", () => {
    /** A fake App Events + Partner meter: permanent idempotency keys (a repeat replays, adds nothing). */
    function fakeShopify() {
      const byKey = new Map<string, number>();
      let quantity = 0; // what Shopify's meter has applied
      let visible = 0; // what the Partner API shows (may lag)
      let loseNextReply = false;
      return {
        get quantity() { return quantity; },
        sync() { visible = quantity; },
        visible: () => visible,
        loseNextReply() { loseNextReply = true; },
        report(units: number, key: string): { ok: boolean; error?: string; replay?: boolean } {
          if (byKey.has(key)) return { ok: false, replay: true, error: "replay" };
          byKey.set(key, units);
          quantity += units;
          if (loseNextReply) { loseNextReply = false; return { ok: false, error: "socket hang up" }; }
          return { ok: true };
        },
      };
    }
    /** One meter run for a Starter shop against the fake Shopify. */
    async function run(shopify: ReturnType<typeof fakeShopify>, cursor: string | null, resolutions: number, nextCursor: string) {
      let saved: string | null = null;
      const out = await meterShop(SHOP, {
        getBilling: async () => ({ status: "active", plan: "starter", lastMeteredCursor: cursor }),
        getTenantId: async () => "t_1",
        readResolutions: async () => ({ resolutions, cursor: nextCursor }),
        readBillingCycle: async () => ({ key: CYCLE, shopId: "gid://shopify/Shop/1", reportedQuantity: shopify.visible() }),
        reportUsage: async ({ units, idempotencyKey }) => shopify.report(units, idempotencyKey),
        saveCursor: async (_s, raw) => { saved = raw; },
        readFreeCycle: async () => FREE_CYCLE,
        reportLimit: async () => true,
      });
      return { out, cursor: saved ?? cursor };
    }

    it("reply lost, new resolutions arrive, Shopify's quantity already shows the send → only the new ones are added", async () => {
      const shopify = fakeShopify();
      let c = (await run(shopify, null, 40, "b1")).cursor; // 40 reported, recorded
      shopify.sync();
      shopify.loseNextReply();
      const lost = await run(shopify, c, 5, "b2"); // Shopify applied 5, we saw an error
      expect(lost.out.error).toBe("socket hang up");
      expect(lost.cursor).toBe(c); // held: nothing recorded
      shopify.sync(); // the Partner API now shows 45
      c = (await run(shopify, c, 8, "b3")).cursor; // the 5 again + 3 new, same hour
      expect(shopify.quantity).toBe(48); // 40 + 5 + 3, not 40 + 5 + 8
      expect(parseMeterCursor(c)).toMatchObject({ cycleResolutions: 48, cycleReported: 48 });
      // Starter: 48 resolutions → 10 paid × $0.49 = $4.90, exactly the tier price.
      expect(Math.max(0, shopify.quantity - 38) * 49).toBe(490);
    });

    it("reply lost and Shopify's quantity still lags → the retry reuses the key, Shopify replays, batch held, then exact", async () => {
      const shopify = fakeShopify();
      let c = (await run(shopify, null, 40, "b1")).cursor;
      shopify.sync();
      shopify.loseNextReply();
      await run(shopify, c, 5, "b2"); // applied 5, reply lost
      const replay = await run(shopify, c, 8, "b3"); // quantity still shows 40: same cumulative key
      expect(replay.out.reportedUnits).toBe(0);
      expect(replay.out.error).toBe("replay");
      expect(replay.cursor).toBe(c);
      expect(shopify.quantity).toBe(45); // the replay added nothing
      shopify.sync();
      c = (await run(shopify, c, 8, "b4")).cursor;
      expect(shopify.quantity).toBe(48);
      expect(parseMeterCursor(c)).toMatchObject({ cycleResolutions: 48, cycleReported: 48 });
    });

    it("cumulative keys: same (cycle, units so far) → same key whatever the batch; next position → new key", async () => {
      const keys: string[] = [];
      for (const [resolutions, nextCursor] of [[5, "x1"], [9, "x2"]] as const) {
        const h = makeDeps({ plan: "starter", resolutions, nextCursor, cursor: cur(10, 10) });
        h.deps.reportUsage = async ({ idempotencyKey }) => { keys.push(idempotencyKey); return { ok: true }; };
        await meterShop(SHOP, h.deps);
      }
      expect(keys[0]).toBe(keys[1]);
      const next = makeDeps({ plan: "starter", resolutions: 1, nextCursor: "x3", cursor: cur(15, 15) });
      next.deps.reportUsage = async ({ idempotencyKey }) => { keys.push(idempotencyKey); return { ok: true }; };
      await meterShop(SHOP, next.deps);
      expect(keys[2]).not.toBe(keys[0]);
      expect(keys.every((k) => k.length <= 64)).toBe(true);
    });

    it("Shopify holding more than we recorded (e.g. an earlier manual test event) is never re-sent; cap still holds", async () => {
      const h = makeDeps({ plan: "starter", resolutions: 5, cursor: cur(440, 440), cycle: { key: CYCLE, shopId: "gid://shopify/Shop/1", reportedQuantity: 444 } });
      await meterShop(SHOP, h.deps);
      expect(h.reported.map((r) => r.units)).toEqual([1]); // count 445, Shopify already has 444 → 1, not 5
      expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleResolutions: 445, cycleReported: 445 });
      const capped = makeDeps({ plan: "starter", resolutions: 9, cursor: cur(440, 440), cycle: { key: CYCLE, shopId: "gid://shopify/Shop/1", reportedQuantity: 444 } });
      const out = await meterShop(SHOP, capped.deps);
      expect(capped.reported.map((r) => r.units)).toEqual([2]); // stops at the 446 ceiling ($199.92)
      expect(out.capped).toBe(true);
    });
  });

  describe("independent review fixes: cycle boundary, trial fallback, holds and alerts", () => {
    const END = "2026-10-01T00:00:00Z";
    const cyc = (extra: Partial<BillingCycle> = {}): BillingCycle => ({ key: CYCLE, shopId: "gid://shopify/Shop/1", end: END, ...extra });
    /** A Starter shop with persisted watch/alert state carried between runs. */
    function shopState() {
      const st = { cursor: cur(40, 40) as string, watch: null as MeterWatch | null, alert: null as string | null, sent: [] as Array<{ units: number; key: string }> };
      const runOnce = async (o: { resolutions?: number; next?: string; cycle?: BillingCycle; now?: number; report?: (u: number, k: string) => { ok: boolean; error?: string; replay?: boolean; serverError?: boolean } }) => {
        const out = await meterShop(SHOP, {
          getBilling: async () => ({ status: "active", plan: "starter", lastMeteredCursor: st.cursor, watch: st.watch, alert: st.alert }),
          getTenantId: async () => "t_1",
          readResolutions: async () => ({ resolutions: o.resolutions ?? 2, cursor: o.next ?? `n${Math.random()}` }),
          readBillingCycle: async () => o.cycle ?? cyc(),
          reportUsage: async ({ units, idempotencyKey }) => { st.sent.push({ units, key: idempotencyKey }); return o.report ? o.report(units, idempotencyKey) : { ok: true }; },
          saveCursor: async (_s, raw) => { st.cursor = raw; },
          readFreeCycle: async () => FREE_CYCLE,
          reportLimit: async () => true,
          writeWatch: async (_s, w, alert) => { st.watch = w; st.alert = alert; },
          now: () => o.now ?? Date.parse("2026-09-15T00:00:00Z"),
        });
        return out;
      };
      return { st, runOnce };
    }

    it("cycle boundary: no send in the last 15 min of a cycle (held, not alerted); 16 min before sends", async () => {
      const a = shopState();
      const held = await a.runOnce({ now: Date.parse(END) - CYCLE_CLOSE_GUARD_MS + 60_000 });
      expect(a.st.sent).toEqual([]);
      expect(held.error).toMatch(/cycle ends/);
      expect(a.st.watch?.hold).toMatchObject({ kind: "cycle-closing", runs: 1 });
      expect(a.st.alert).toBeNull();
      expect(a.st.cursor).toBe(cur(40, 40));
      const b = shopState();
      await b.runOnce({ now: Date.parse(END) - CYCLE_CLOSE_GUARD_MS - 60_000 });
      expect(b.st.sent.map((x) => x.units)).toEqual([2]);
      // after the rollover the held batch is counted + reported in the new cycle
      const after = await a.runOnce({ now: Date.parse(END) + 60_000, cycle: { key: END, shopId: "gid://shopify/Shop/1", end: "2026-10-31T00:00:00Z" } });
      expect(after.reportedUnits).toBe(2);
      expect(parseMeterCursor(a.st.cursor)).toMatchObject({ cycleKey: END, cycleResolutions: 2, cycleReported: 2 });
      expect(a.st.watch?.hold).toBeUndefined();
    });

    it("cycle keys compare as instants: '…00Z' and '….000Z' are the same cycle (counters continue)", async () => {
      expect(sameCycleKey("2026-09-01T00:00:00Z", "2026-09-01T00:00:00.000Z")).toBe(true);
      expect(sameCycleKey("2026-09-01T00:00:00Z", "2026-09-01T00:00:00+00:00")).toBe(true);
      expect(sameCycleKey("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(false);
      expect(sameCycleKey("trial:x", "trial:x")).toBe(true);
      expect(sameCycleKey(null, "2026-09-01T00:00:00Z")).toBe(false);
      const h = makeDeps({ plan: "starter", resolutions: 3, cursor: cur(440, 440, "2026-09-01T00:00:00.000Z") });
      await meterShop(SHOP, h.deps);
      expect(h.reported.map((r) => r.units)).toEqual([3]); // 443 ≤ 446: same cycle, not a fresh 0
      expect(parseMeterCursor(h.saved.at(-1))).toMatchObject({ cycleResolutions: 443, cycleReported: 443 });
    });

    it("trial fallback: Shopify stops returning trialEndsAt → the stored trial end still keeps last-day trial resolutions free", async () => {
      const T = "2026-10-23T17:36:35Z";
      const fromTrialKey = serializeMeterCursor({ cursor: "c0", cycleKey: `trial:${T}`, cycleResolutions: 9, cycleReported: 0 });
      const h = makeDeps({
        plan: "starter", resolutions: 3, cursor: fromTrialKey,
        occurredAt: ["2026-10-23T08:00:00Z", "2026-10-23T17:36:00Z", "2026-10-24T09:00:00Z"],
        cycle: { key: T, shopId: "gid://shopify/Shop/1" }, // no trialEndsAt
      });
      await meterShop(SHOP, h.deps);
      expect(h.reported.map((r) => r.units)).toEqual([1]);
      const saved = parseMeterCursor(h.saved.at(-1));
      expect(saved).toMatchObject({ cycleKey: T, cycleResolutions: 1, cycleReported: 1, trialEnd: T });
      // A later run (cursor now on the paid cycle) still knows the trial end from `trialEnd`.
      const later = makeDeps({ plan: "starter", resolutions: 2, cursor: h.saved.at(-1)!, nextCursor: "c9", occurredAt: ["2026-10-23T12:00:00Z", "2026-10-25T12:00:00Z"], cycle: { key: T, shopId: "gid://shopify/Shop/1" } });
      await meterShop(SHOP, later.deps);
      expect(later.reported.map((r) => r.units)).toEqual([1]);
    });

    it("replay hold alerts only once it lasts more than 2 runs, and clears on success", async () => {
      const a = shopState();
      const replay = () => ({ ok: false, replay: true, error: "replay" });
      await a.runOnce({ report: replay });
      await a.runOnce({ report: replay });
      expect(a.st.watch?.hold).toMatchObject({ kind: "replay", runs: 2 });
      expect(a.st.alert).toBeNull();
      await a.runOnce({ report: replay });
      expect(a.st.alert).toMatch(/replay hold for 3 run/);
      await a.runOnce({ cycle: cyc({ reportedQuantity: 42 }) }); // Shopify now shows the earlier send
      expect(a.st.alert).toBeNull();
      expect(a.st.watch?.hold).toBeUndefined();
    });

    it("a Shopify server error is never resent: alert at once, every later run holds without sending, released when the meter shows it", async () => {
      const a = shopState();
      await a.runOnce({ report: () => ({ ok: false, serverError: true, error: "App Events 500: INTERNAL_ERROR" }) });
      expect(a.st.sent).toHaveLength(1);
      expect(a.st.alert).toMatch(/not resent/);
      expect(a.st.watch?.hold?.attempt).toMatchObject({ cycleKey: CYCLE, from: 40, units: 2 });
      const blocked = await a.runOnce({ resolutions: 5, cycle: cyc({ reportedQuantity: 40 }) });
      expect(a.st.sent).toHaveLength(1); // NOT resent
      expect(blocked.error).toMatch(/not resent/);
      expect(a.st.alert).toMatch(/server-error hold/);
      expect(a.st.cursor).toBe(cur(40, 40));
      // Shopify's meter shows the 2 units after all: hold released, the rest is reported once.
      const ok = await a.runOnce({ resolutions: 5, cycle: cyc({ reportedQuantity: 42 }) });
      expect(ok.reportedUnits).toBe(3); // count 45, Shopify has 42
      expect(a.st.watch?.hold).toBeUndefined();
      expect(a.st.alert).toBeNull();
    });

    it("periodic check: with no new resolutions, our count vs Shopify's meter alerts after more than 2 mismatched runs", async () => {
      const a = shopState();
      for (let i = 0; i < 2; i++) await a.runOnce({ resolutions: 0, cycle: cyc({ reportedQuantity: 37 }) });
      expect(a.st.watch?.mismatch).toMatchObject({ runs: 2, ours: 40, shopify: 37 });
      expect(a.st.alert).toBeNull();
      await a.runOnce({ resolutions: 0, cycle: cyc({ reportedQuantity: 37 }) });
      expect(a.st.alert).toMatch(/usage mismatch for 3 runs.*shows 37.*recorded 40.*Dev Dashboard/);
      await a.runOnce({ resolutions: 0, cycle: cyc({ reportedQuantity: 40 }) });
      expect(a.st.alert).toBeNull();
      expect(a.st.watch?.mismatch).toBeUndefined();
    });

    it("usageTierOf refuses a non-USD tier (the plan catalog is USD)", () => {
      const eur = { items: [{ handle: "ai_resolution", description: null, usage: null, price: { __typename: "TieredPrice" as const, active: true, currency: "EUR", tiersMode: "GRADUATED" as const,
        tiers: [{ upTo: 38, amountPerUnit: "0.0", amount: null }, { upTo: null, amountPerUnit: "0.49", amount: null }] } }] };
      expect(usageTierOf(eur)).toEqual({ freeUnits: null, overageCents: null });
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
