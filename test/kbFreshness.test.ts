import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ALERT_AFTER_HOURS, classifyReachability, freshnessHealth, isDue, runBackstop, runInFlight, selectDue,
  type BackstopDeps, type FreshnessRow, type ReachProbe,
} from "../app/lib/kbFreshness";

/**
 * #52 — knowledge freshness. The backstop re-trains active shops older than 72 h,
 * marks deleted stores inactive (never retried), stays idempotent and rate-limited;
 * the health verdict is RED on a > 96 h shop AND on the absence of a finished run.
 */
const NOW = new Date("2026-10-04T15:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const row = (shop: string, trainedHoursAgo: number | null, over: Partial<FreshnessRow> = {}): FreshnessRow => ({
  shop, provisionState: "published", bmaiTenantId: `t_${shop}`, kbTrainedAt: trainedHoursAgo === null ? null : hoursAgo(trainedHoursAgo), inactiveAt: null, ...over,
});
const LIVE: ReachProbe = { admin: 401, storefront: 302 };
const GONE: ReachProbe = { admin: 404, storefront: 404 };

function harness(rows: FreshnessRow[], probes: Record<string, ReachProbe> = {}, retrainOk: Record<string, boolean> = {}) {
  const table = new Map(rows.map((r) => [r.shop, { ...r }]));
  const calls = { retrain: [] as string[], inactive: [] as Array<[string, string]>, sleeps: [] as number[], probes: [] as string[] };
  const deps: BackstopDeps = {
    listTenants: async () => [...table.values()],
    readTenant: async (shop) => table.get(shop) ?? null,
    probe: async (shop) => { calls.probes.push(shop); return probes[shop] ?? LIVE; },
    retrain: async (shop) => {
      calls.retrain.push(shop);
      if (retrainOk[shop] === false) return { ok: false, error: "publish_tenant_runtime: boom" };
      table.get(shop)!.kbTrainedAt = NOW;
      return { ok: true };
    },
    markInactive: async (shop, reason) => { calls.inactive.push([shop, reason]); table.get(shop)!.inactiveAt = NOW; },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    now: () => NOW,
    random: () => 0.5,
    log: () => {},
  };
  return { deps, calls, table };
}

describe("due selection", () => {
  it("is due at ≥ 72 h or never trained; never for inactive / suspended / unprovisioned", () => {
    expect(isDue(row("a", 71.9), NOW)).toBe(false);
    expect(isDue(row("a", 72), NOW)).toBe(true);
    expect(isDue(row("a", null), NOW)).toBe(true);
    expect(isDue(row("a", 500, { inactiveAt: hoursAgo(1) }), NOW)).toBe(false);
    expect(isDue(row("a", 500, { provisionState: "suspended" }), NOW)).toBe(false);
    expect(isDue(row("a", 500, { bmaiTenantId: null }), NOW)).toBe(false);
  });
  it("orders oldest first, never-trained first of all", () => {
    expect(selectDue([row("b", 100), row("c", null), row("a", 800), row("fresh", 1)], NOW).map((r) => r.shop)).toEqual(["c", "a", "b"]);
  });
});

describe("classifyReachability — only a double 404 inactivates", () => {
  it.each([
    [{ admin: 404, storefront: 404 }, "gone"],
    [{ admin: 401, storefront: 302 }, "reachable"],
    [{ admin: 401, storefront: 200 }, "reachable"],
    [{ admin: 404, storefront: 302 }, "unknown"],
    [{ admin: null, storefront: 404 }, "unknown"],
    [{ admin: 503, storefront: 503 }, "unknown"],
    [{ admin: 402, storefront: 402 }, "unavailable"],
    [{ admin: 401, storefront: 423 }, "unavailable"],
  ] as Array<[ReachProbe, string]>)("%j → %s", (probe, verdict) => {
    expect(classifyReachability(probe)).toBe(verdict);
  });
});

describe("runBackstop", () => {
  it("re-trains the stale live shops, marks the deleted ones inactive (not retried), leaves fresh ones alone", async () => {
    const rows = [row("live-1", 768), row("live-2", 240), row("dead-1", 768), row("fresh", 50), row("gone-already", 900, { inactiveAt: hoursAgo(10) })];
    const { deps, calls } = harness(rows, { "dead-1": GONE });
    const s = await runBackstop(deps);
    expect(calls.retrain.sort()).toEqual(["live-1", "live-2"]);
    expect(calls.inactive).toEqual([["dead-1", "shop_not_found"]]);
    expect(calls.probes).not.toContain("fresh");
    expect(calls.probes).not.toContain("gone-already");
    expect(s).toMatchObject({ considered: 5, active: 4, due: 3, trained: 2, failed: 0, inactivated: 1, ok: true });

    // Second run: nothing is due (trained now), the dead shop is never probed or retried again.
    calls.retrain.length = 0; calls.probes.length = 0;
    const again = await runBackstop(deps);
    expect(again.due).toBe(0);
    expect(calls.retrain).toEqual([]);
    expect(calls.probes).toEqual([]);
  });

  it("is idempotent: a shop a webhook trained while the run waited is skipped, not re-trained", async () => {
    const { deps, calls, table } = harness([row("a", 100), row("b", 100)]);
    const sleep = deps.sleep;
    deps.sleep = async (ms) => { await sleep(ms); table.get("b")!.kbTrainedAt = NOW; };
    const s = await runBackstop(deps);
    expect(calls.retrain).toEqual(["a"]);
    expect(s.skipped).toBe(1);
    expect(s.results.find((r) => r.shop === "b")?.result).toBe("not-due");
  });

  it("rate-limits: spacing + jitter between shops, and a per-run cap defers the rest", async () => {
    const { deps, calls } = harness([row("a", 100), row("b", 101), row("c", 102)]);
    const s = await runBackstop(deps, { maxPerRun: 2, spacingMs: 3000, jitterMs: 2000 });
    expect(s.trained).toBe(2);
    expect(s.deferred).toBe(1);
    expect(calls.sleeps[0]).toBe(1000); // initial jitter only
    expect(calls.sleeps[1]).toBe(4000); // spacing + jitter
  });

  it("a training failure is counted + surfaced (ok:false), never swallowed, and never inactivates", async () => {
    const { deps, calls } = harness([row("a", 100), row("b", 100)], {}, { a: false });
    const s = await runBackstop(deps);
    expect(s.ok).toBe(false);
    expect(s.failed).toBe(1);
    expect(s.trained).toBe(1);
    expect(s.results.find((r) => r.shop === "a")).toMatchObject({ result: "failed", error: "publish_tenant_runtime: boom" });
    expect(calls.inactive).toEqual([]);
  });

  it("an unreachable-for-now shop (402, network error) is skipped, not inactivated", async () => {
    const { deps, calls } = harness([row("frozen", 100), row("flaky", 100)], { frozen: { admin: 402, storefront: 402 }, flaky: { admin: null, storefront: null } });
    const s = await runBackstop(deps);
    expect(calls.inactive).toEqual([]);
    expect(calls.retrain).toEqual([]);
    expect(s.skipped).toBe(2);
  });

  it("--dry-run writes nothing", async () => {
    const { deps, calls } = harness([row("live", 100), row("dead", 100)], { dead: GONE });
    const s = await runBackstop(deps, { dryRun: true });
    expect(calls.retrain).toEqual([]);
    expect(calls.inactive).toEqual([]);
    expect(s.results.map((r) => r.result).sort()).toEqual(["inactivated", "would-train"]);
  });
});

describe("runInFlight — the lease", () => {
  it("only an unfinished run younger than the lease blocks", () => {
    expect(runInFlight(null, NOW)).toBe(false);
    expect(runInFlight({ startedAt: hoursAgo(0.5), finishedAt: null }, NOW)).toBe(true);
    expect(runInFlight({ startedAt: hoursAgo(3), finishedAt: null }, NOW)).toBe(false);
    expect(runInFlight({ startedAt: hoursAgo(0.5), finishedAt: hoursAgo(0.4) }, NOW)).toBe(false);
  });
});

describe("freshnessHealth — fail-closed", () => {
  const recentRun = { finishedAt: hoursAgo(2) };
  it("green when every active shop is ≤ 96 h and a run finished recently", () => {
    const h = freshnessHealth([row("a", 10), row("b", 95), row("dead", 900, { inactiveAt: hoursAgo(1) })], recentRun, NOW);
    expect(h.verdict).toBe("green");
    expect(h.activeShops).toBe(2);
  });
  it("RED on any active shop older than 96 h, or never trained", () => {
    expect(freshnessHealth([row("a", 10), row("b", ALERT_AFTER_HOURS + 1)], recentRun, NOW)).toMatchObject({ verdict: "red", staleShops: 1, stale: [{ shop: "b" }] });
    expect(freshnessHealth([row("a", null)], recentRun, NOW)).toMatchObject({ verdict: "red", neverTrained: 1 });
  });
  it("RED on the ABSENCE of success: no finished run, or the last one is older than the silence limit", () => {
    expect(freshnessHealth([row("a", 1)], null, NOW).verdict).toBe("red");
    expect(freshnessHealth([row("a", 1)], { finishedAt: hoursAgo(15) }, NOW).verdict).toBe("red");
  });
  it("UNVERIFIED (never green) when the table could not be read", () => {
    expect(freshnessHealth(null, recentRun, NOW).verdict).toBe("unverified");
  });
});

describe("wiring", () => {
  const root = join(__dirname, "..");
  it("the systemd timer exists and runs the backstop script as deploy with the env file", () => {
    const svc = readFileSync(join(root, "deploy/systemd/busymate-ai-shopify-kb-freshness.service"), "utf8");
    const timer = readFileSync(join(root, "deploy/systemd/busymate-ai-shopify-kb-freshness.timer"), "utf8");
    expect(svc).toMatch(/^ExecStart=.*scripts\/kb-freshness\.ts$/m);
    expect(svc).toMatch(/^User=deploy$/m);
    expect(svc).toMatch(/^EnvironmentFile=\/etc\/busymate-ai-shopify\/env$/m);
    expect(timer).toMatch(/^Unit=busymate-ai-shopify-kb-freshness\.service$/m);
    expect(timer).toMatch(/^RandomizedDelaySec=\d+/m);
  });
  it("schema + an additive migration carry the inactive marker and the run ledger", () => {
    const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
    const sql = readFileSync(join(root, "prisma/migrations/20261004150000_kb_freshness/migration.sql"), "utf8");
    expect(schema.match(/model ShopTenant \{([\s\S]*?)\n\}/)?.[1]).toMatch(/^\s*inactiveAt\s+DateTime\?/m);
    expect(schema).toMatch(/^model KbFreshnessRun \{/m);
    expect(sql).toMatch(/ADD COLUMN "inactiveAt" TIMESTAMPTZ/);
    expect(sql).toMatch(/CREATE TABLE "KbFreshnessRun"/);
    expect(sql).not.toMatch(/DROP|ALTER COLUMN/);
  });
  it("shopify.app.toml subscribes shop/update to the kb/shop route", () => {
    const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");
    expect(toml).toMatch(/topics = \[ "shop\/update" \]\nuri = "https:\/\/store\.busymate\.ai\/webhooks\/kb\/shop"/);
  });
});

describe("/api/kb/health route", () => {
  it("answers 503 on red and strips per-shop detail without the operator secret; 200 on green", async () => {
    const health = vi.fn();
    vi.doMock("../app/lib/kbFreshness.server", () => ({ readFreshnessHealth: health }));
    process.env.BILLING_METER_SECRET = "operator-secret-example-0000000000";
    const { loader } = await import("../app/routes/api.kb.health");
    health.mockResolvedValueOnce(freshnessHealth([row("a", 200)], { finishedAt: hoursAgo(1) }, NOW));
    const red = await loader({ request: new Request("https://store.busymate.ai/api/kb/health"), params: {}, context: {} } as never);
    expect(red.status).toBe(503);
    const body = await red.json();
    expect(body).toMatchObject({ ok: false, verdict: "red", staleShops: 1 });
    expect(body.stale).toBeUndefined();

    health.mockResolvedValueOnce(freshnessHealth([row("a", 200)], { finishedAt: hoursAgo(1) }, NOW));
    const op = await loader({ request: new Request("https://store.busymate.ai/api/kb/health", { headers: { "x-billing-meter-secret": "operator-secret-example-0000000000" } }), params: {}, context: {} } as never);
    expect((await op.json()).stale).toEqual([{ shop: "a", ageHours: 200 }]);

    health.mockResolvedValueOnce(freshnessHealth(null, null, NOW));
    expect((await loader({ request: new Request("https://store.busymate.ai/api/kb/health"), params: {}, context: {} } as never)).status).toBe(503);

    health.mockResolvedValueOnce(freshnessHealth([row("a", 1)], { finishedAt: hoursAgo(1) }, NOW));
    expect((await loader({ request: new Request("https://store.busymate.ai/api/kb/health"), params: {}, context: {} } as never)).status).toBe(200);
  });
});
