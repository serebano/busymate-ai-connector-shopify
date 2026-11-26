import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FREE_PLAN_ID,
  PLANS,
  describePlan,
  formatUsd,
  parseListingPlanFeatures,
  planByHandle,
  planFor,
  computeUsageReport,
  reportableUnitsCeiling,
} from "../app/lib/plans";
import { loadRepoArtifacts } from "../scripts/lib/store-canonical.mjs";

/**
 * PLAN CATALOG ↔ listing/pricing.json DRIFT (App Store Req 1.1.4 "factual copy" +
 * 1.2.1/1.2.2). The in-app plan list once showed per-resolution prices and caps that
 * contradicted the Partner-Dashboard plans (the Aug-31 rejection). This test pins
 * the ONE in-app catalog to the repo's source-of-record for the Partner Dashboard
 * entry (`listing/pricing.json`, itself asserted against the canonical store
 * record by `npm run drift-check`), so a price change must land in both or the
 * suite goes red.
 */
const ROOT = process.cwd();

describe("plan catalog == listing/pricing.json (drift gate)", () => {
  const { pricingJson } = loadRepoArtifacts(ROOT);

  it("listing/pricing.json is present and has the four Partner plans", () => {
    expect(pricingJson).not.toBeNull();
    expect((pricingJson ?? []).map((p: { name: string }) => p.name).sort()).toEqual(
      ["Free", "Growth", "Scale", "Starter"],
    );
  });

  it("every in-app plan matches its listing plan (fee · included · overage · cap)", () => {
    for (const plan of PLANS) {
      const listed = (pricingJson ?? []).find((p: { name: string }) => p.name === plan.name);
      expect(listed, `listing/pricing.json has no plan named ${plan.name}`).toBeDefined();
      expect(plan.monthlyCents, `${plan.name} monthly fee`).toBe(Number(listed!.amountCents));
      const parsed = parseListingPlanFeatures(listed!.features as string[]);
      expect(plan.includedResolutions, `${plan.name} included allowance`).toBe(parsed.includedResolutions);
      expect(plan.overageCents, `${plan.name} overage`).toBe(parsed.overageCents);
      expect(plan.capCents, `${plan.name} cap`).toBe(parsed.capCents);
    }
    expect(PLANS).toHaveLength((pricingJson ?? []).length);
  });

  it("the Partner plan handles are the ids (free/starter/growth/scale)", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["free", "starter", "growth", "scale"]);
    for (const p of PLANS) expect(p.handle).toBe(p.id);
  });

  it("paid plans carry the 14-day trial; Free has none", () => {
    for (const p of PLANS) expect(p.trialDays).toBe(p.monthlyCents > 0 ? 14 : 0);
  });
});

describe("parseListingPlanFeatures", () => {
  it("parses a paid plan's included/overage/cap from the listing feature strings", () => {
    expect(
      parseListingPlanFeatures([
        "225 AI resolutions included, then $0.44/resolution",
        "$1,000/month spend cap",
        "Unlimited seats",
      ]),
    ).toEqual({ includedResolutions: 225, overageCents: 44, capCents: 100000 });
  });
  it("parses the Free plan (allowance, no overage, no cap)", () => {
    expect(parseListingPlanFeatures(["25 AI resolutions/month, then routes to your team", "No credit card required"])).toEqual({
      includedResolutions: 25,
      overageCents: null,
      capCents: null,
    });
  });
  it("fails closed on an unparseable allowance (never silently 0)", () => {
    expect(() => parseListingPlanFeatures(["Unlimited seats"])).toThrow(/allowance/);
  });
});

describe("catalog helpers", () => {
  it("planFor defaults to Free (no subscription ⇒ Free), never a paid plan", () => {
    expect(planFor(null).id).toBe(FREE_PLAN_ID);
    expect(planFor("nope").id).toBe(FREE_PLAN_ID);
    expect(planFor("growth").id).toBe("growth");
  });
  it("planByHandle matches the Shopify App Pricing plan_handle case-insensitively", () => {
    expect(planByHandle("Growth")?.id).toBe("growth");
    expect(planByHandle("SCALE")?.id).toBe("scale");
    expect(planByHandle("enterprise")).toBeNull();
  });
  it("describePlan is honest merchant copy (fee, allowance, overage, cap, trial)", () => {
    expect(describePlan(planFor("starter"))).toBe(
      "$19/month · 38 resolutions included, then $0.49 each · $200/month overage cap · 14-day free trial",
    );
    expect(describePlan(planFor("free"))).toBe("$0/month · 25 resolutions included, then conversations route to your team");
    expect(describePlan(planFor("scale"))).toContain("$5,000/month overage cap");
  });
  it("formatUsd renders whole dollars without cents and fractional with two", () => {
    expect(formatUsd(1900)).toBe("$19");
    expect(formatUsd(49)).toBe("$0.49");
    expect(formatUsd(500000)).toBe("$5,000");
  });
});

/**
 * What Shopify charges for a cycle's reported quantity under the live App Pricing usage tier
 * (GRADUATED: first `included` units free, then `overage` each — Partner API activeSubscription
 * items + approve-charge page, 2026-11-26).
 */
function shopifyTierChargeCents(plan: ReturnType<typeof planFor>, quantity: number): number {
  return Math.max(0, quantity - plan.includedResolutions) * (plan.overageCents ?? 0);
}

/** Feed resolutions one batch at a time through computeUsageReport; return Shopify's total quantity. */
function runCycle(plan: ReturnType<typeof planFor>, batches: number[]): { quantity: number; capped: boolean } {
  let counted = 0;
  let reported = 0;
  let capped = false;
  for (const n of batches) {
    const r = computeUsageReport({ plan, cycleResolutions: counted, reportedBefore: reported, newResolutions: n });
    counted += n;
    reported += r.units;
    capped = r.capped;
  }
  return { quantity: reported, capped };
}

describe("computeUsageReport (Shopify's tier applies the allowance; app enforces the cap)", () => {
  const starter = planFor("starter"); // 38 included, then $0.49, $200 cap
  const growth = planFor("growth"); // 225 included, then $0.44, $1,000 cap
  const scale = planFor("scale"); // 830 included, then $0.42, $5,000 cap

  it("reports every resolution, so Shopify's free first tier IS the allowance (no double allowance)", () => {
    expect(computeUsageReport({ plan: starter, cycleResolutions: 0, reportedBefore: 0, newResolutions: 10 })).toEqual({ units: 10, capped: false });
    expect(computeUsageReport({ plan: starter, cycleResolutions: 30, reportedBefore: 30, newResolutions: 10 })).toEqual({ units: 10, capped: false });
  });

  it("Starter: 38 resolutions cost $0, the 39th costs exactly $0.49, 100 cost $30.38", () => {
    expect(shopifyTierChargeCents(starter, runCycle(starter, [38]).quantity)).toBe(0);
    expect(shopifyTierChargeCents(starter, runCycle(starter, [38, 1]).quantity)).toBe(49);
    expect(shopifyTierChargeCents(starter, runCycle(starter, [20, 30, 50]).quantity)).toBe(62 * 49); // 3038
    // The old code reported only units past 38, so Shopify's free tier swallowed 38 more:
    // 100 resolutions would have cost max(0, 62 - 38) × $0.49 = $11.76 instead of $30.38.
  });

  it("Growth: 225 free, the 226th costs $0.44; Scale: 830 free, the 831st costs $0.42", () => {
    expect(shopifyTierChargeCents(growth, runCycle(growth, [225]).quantity)).toBe(0);
    expect(shopifyTierChargeCents(growth, runCycle(growth, [200, 26]).quantity)).toBe(44);
    expect(shopifyTierChargeCents(scale, runCycle(scale, [830]).quantity)).toBe(0);
    expect(shopifyTierChargeCents(scale, runCycle(scale, [831]).quantity)).toBe(42);
  });

  it("the cap: a cycle never reports past included + floor(cap / price) units, so charges stay ≤ the cap", () => {
    expect(reportableUnitsCeiling(starter)).toBe(38 + 408); // 446
    expect(reportableUnitsCeiling(growth)).toBe(225 + 2272); // 2497
    expect(reportableUnitsCeiling(scale)).toBe(830 + 11904); // 12734
    const s = runCycle(starter, [400, 40, 6, 1, 500]);
    expect(s).toEqual({ quantity: 446, capped: true });
    expect(shopifyTierChargeCents(starter, s.quantity)).toBe(19992); // $199.92 ≤ $200
    expect(shopifyTierChargeCents(growth, runCycle(growth, [3000]).quantity)).toBe(99968); // $999.68 ≤ $1,000
    expect(shopifyTierChargeCents(scale, runCycle(scale, [20000]).quantity)).toBe(499968); // $4,999.68 ≤ $5,000
  });

  it("at the ceiling exactly: reports the last unit and flags capped; after it reports 0", () => {
    expect(computeUsageReport({ plan: starter, cycleResolutions: 440, reportedBefore: 440, newResolutions: 6 })).toEqual({ units: 6, capped: true });
    expect(computeUsageReport({ plan: starter, cycleResolutions: 446, reportedBefore: 446, newResolutions: 5 })).toEqual({ units: 0, capped: true });
    expect(computeUsageReport({ plan: starter, cycleResolutions: 439, reportedBefore: 439, newResolutions: 6 })).toEqual({ units: 6, capped: false });
  });

  it("reportedBefore is what Shopify already holds: the next report tops its quantity up to the cycle count", () => {
    const r = computeUsageReport({ plan: starter, cycleResolutions: 37, reportedBefore: 30, newResolutions: 5 });
    expect(r).toEqual({ units: 12, capped: false }); // 30 + 12 = 42 = 37 + 5
    expect(shopifyTierChargeCents(starter, 30 + r.units)).toBe(4 * 49);
  });

  it("the Free plan never produces usage units", () => {
    expect(reportableUnitsCeiling(planFor("free"))).toBe(0);
    expect(computeUsageReport({ plan: planFor("free"), cycleResolutions: 1000, reportedBefore: 0, newResolutions: 50 })).toEqual({ units: 0, capped: false });
  });
});

describe("the repo's plan copy has no stale per-resolution-only pricing", () => {
  it("usageBilling re-exports the same catalog (one source)", async () => {
    const mod = await import("../app/lib/usageBilling");
    expect(mod.PLANS).toBe(PLANS);
  });
  it("the billing page + home never claim 'billed only for conversations it resolves'", () => {
    for (const rel of ["app/routes/app.billing.tsx", "app/routes/app._index.tsx"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, rel).not.toMatch(/billed only for conversations/i);
      expect(src, rel).not.toMatch(/Pay per resolution/i);
    }
  });
});
