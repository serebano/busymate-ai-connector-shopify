import { describe, expect, it } from "vitest";
import { homeActivation } from "../app/lib/homeActivation";

/**
 * Shopify review 5.1.2 (audit 2026-10-02): the fresh-install first paint.
 * The reviewer's 2026-09-24 screencast 2 saw "0/4 · Provisioning" with the embed
 * CTA ENABLED and a page that never re-checked; this pins the derivation that
 * holds the CTA and keeps re-checking until the tenant is published and frameable.
 */
describe("homeActivation", () => {
  it("a pending tenant (afterAuth still publishing) is activating and the CTA is held", () => {
    expect(homeActivation({ provisionState: "pending", published: false, runtime: null, frameable: null })).toEqual({
      embedReady: false,
      activating: true,
    });
  });

  it("a suspended tenant during a reinstall is activating and the CTA is held", () => {
    expect(homeActivation({ provisionState: "suspended", published: false, runtime: null, frameable: null })).toEqual({
      embedReady: false,
      activating: true,
    });
  });

  it("a provisioning error holds the CTA but is not activating (Retry setup, no endless spinner)", () => {
    expect(homeActivation({ provisionState: "error", published: false, runtime: null, frameable: null })).toEqual({
      embedReady: false,
      activating: false,
    });
  });

  it("published + frameable offers the CTA and stops re-checking", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "pending", frameable: true })).toEqual({
      embedReady: true,
      activating: false,
    });
  });

  it("published but the platform refuses the frame: held and re-checking", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "ready", frameable: false })).toEqual({
      embedReady: false,
      activating: true,
    });
  });

  it("published, platform unreachable, runtime pending: held and re-checking", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "pending", frameable: null })).toEqual({
      embedReady: false,
      activating: true,
    });
  });

  it("published, platform unreachable, runtime unverified: offered (couldn't ask never holds it)", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "unverified", frameable: null })).toEqual({
      embedReady: true,
      activating: false,
    });
  });

  it("published with a runtime error is held but not activating", () => {
    expect(homeActivation({ provisionState: "published", published: true, runtime: "error", frameable: null })).toEqual({
      embedReady: false,
      activating: false,
    });
  });
});
