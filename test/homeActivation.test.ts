import { describe, expect, it } from "vitest";
import { homeActivation } from "../app/lib/homeActivation";

/**
 * Shopify review 5.1.2 (audit 2026-10-02): the fresh-install first paint.
 * The reviewer's 2026-09-24 screencast 2 saw "0/4 · Provisioning" with the embed
 * CTA ENABLED and a page that never re-checked; this pins the derivation that
 * holds the CTA and keeps re-checking until the tenant is published and frameable.
 *
 * 0.1.15 — the RE-CHECK condition is separate from the HOLD condition. Found live
 * on a reinstall (busymate-ai-review-test-7, app 0.1.14): the platform answered
 * frameable:true before the runtime read said ready, so the CTA was offered, the
 * hold was off, and nothing re-checked — "1/4 done · Activating" with "Assistant
 * provisioned: To do" sat stale until a manual reload showed "2/4 · Live".
 */
describe("homeActivation", () => {
  it("a pending tenant (afterAuth still publishing) is activating, held and re-checking", () => {
    expect(homeActivation({ provisionState: "pending", published: false, runtime: null, frameable: null })).toEqual({
      embedReady: false,
      activating: true,
      recheck: true,
    });
  });

  it("a suspended tenant during a reinstall is activating, held and re-checking", () => {
    expect(homeActivation({ provisionState: "suspended", published: false, runtime: null, frameable: null })).toEqual({
      embedReady: false,
      activating: true,
      recheck: true,
    });
  });

  it("a provisioning error holds the CTA, is not activating and is not re-polled (Retry setup, no endless spinner)", () => {
    expect(homeActivation({ provisionState: "error", published: false, runtime: null, frameable: null })).toEqual({
      embedReady: false,
      activating: false,
      recheck: false,
    });
  });

  // The 0.1.15 reinstall case: the CTA is offered on frameable:true, the hold is
  // off, but the runtime is still pending, so Home MUST keep re-checking.
  it("reinstall: published, runtime pending, frameable true → CTA offered, not activating, still re-checking", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "pending", frameable: true })).toEqual({
      embedReady: true,
      activating: false,
      recheck: true,
    });
  });

  it("published + frameable + runtime ready offers the CTA and stops re-checking", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "ready", frameable: true })).toEqual({
      embedReady: true,
      activating: false,
      recheck: false,
    });
  });

  it("published but the platform refuses the frame: held, activating and re-checking (even with the runtime ready)", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "ready", frameable: false })).toEqual({
      embedReady: false,
      activating: true,
      recheck: true,
    });
  });

  it("published, platform unreachable, runtime pending: held and re-checking", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "pending", frameable: null })).toEqual({
      embedReady: false,
      activating: true,
      recheck: true,
    });
  });

  it("published, platform unreachable, runtime unverified: offered (couldn't ask never holds it) but still re-checking", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "unverified", frameable: null })).toEqual({
      embedReady: true,
      activating: false,
      recheck: true,
    });
  });

  it("published, frameable, runtime orphaned (being repaired): offered, not held, re-checking until the repair lands", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "orphaned", frameable: true })).toEqual({
      embedReady: true,
      activating: false,
      recheck: true,
    });
  });

  it("published with a runtime error is held, not activating and not re-polled", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "error", frameable: null })).toEqual({
      embedReady: false,
      activating: false,
      recheck: false,
    });
  });

  it("re-checks exactly when held OR the runtime has not settled (ready/error are the settled states)", () => {
    const runtimes = ["ready", "pending", "error", "unverified", "orphaned", null] as const;
    for (const runtime of runtimes) {
      for (const frameable of [true, false, null] as const) {
        const out = homeActivation({ provisionState: "published", published: true, runtime, frameable });
        const settled = runtime === "ready" || runtime === "error";
        expect(out.recheck, `runtime=${runtime} frameable=${frameable}`).toBe(out.activating || !settled);
        // The hold never outlives the CTA: an offered CTA is never "activating".
        if (out.embedReady) expect(out.activating).toBe(false);
      }
    }
  });
});
