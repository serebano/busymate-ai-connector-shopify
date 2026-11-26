import { describe, expect, it } from "vitest";
import { freeLimitNotice, freeLimitState, monthlyWindow } from "../app/lib/freeLimit";
import { serializeMeterCursor } from "../app/lib/meterCursor";

/** The Free allowance month (docs/BILLING.md "Free plan limit"): anchored windows and the reached rule. */
describe("monthlyWindow", () => {
  const anchor = new Date("2026-01-31T10:00:00Z");
  it("the window containing now, anchored on the install day (clamped to short months)", () => {
    expect(monthlyWindow(anchor, new Date("2026-02-15T00:00:00Z"))).toEqual({ key: "2026-01-31T10:00:00.000Z", end: "2026-02-28T10:00:00.000Z" });
    expect(monthlyWindow(anchor, new Date("2026-03-01T00:00:00Z"))).toEqual({ key: "2026-02-28T10:00:00.000Z", end: "2026-03-31T10:00:00.000Z" });
    expect(monthlyWindow(anchor, new Date("2026-12-31T10:00:00Z"))).toEqual({ key: "2026-12-31T10:00:00.000Z", end: "2027-01-31T10:00:00.000Z" });
  });
  it("before the anchor → the first window; a window is never longer than 31 days", () => {
    expect(monthlyWindow(anchor, new Date("2026-01-01T00:00:00Z")).key).toBe(anchor.toISOString());
    for (let m = 0; m < 24; m++) {
      const w = monthlyWindow(anchor, new Date(Date.UTC(2026, m, 15)));
      expect(Date.parse(w.end) - Date.parse(w.key)).toBeLessThanOrEqual(31 * 86_400_000);
      expect(Date.parse(w.end)).toBeGreaterThan(Date.UTC(2026, m, 15));
    }
  });
});

describe("freeLimitState", () => {
  it("reached at exactly the included allowance", () => {
    expect(freeLimitState({ included: 25, used: 24, resetsAt: null }).reached).toBe(false);
    expect(freeLimitState({ included: 25, used: 25, resetsAt: "x" })).toEqual({ reached: true, used: 25, included: 25, resetsAt: "x" });
  });
});

describe("freeLimitNotice (merchant banner)", () => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const cursor = (n: number, end: string | null = future) => serializeMeterCursor({ cursor: "c", cycleKey: "k", cycleResolutions: n, cycleEnd: end });
  it("Free or no plan selected, allowance used, cycle not reset → the notice", () => {
    expect(freeLimitNotice({ status: "active", plan: "free", lastMeteredCursor: cursor(26) }, 25)).toEqual({ reached: true, used: 26, included: 25, resetsAt: future });
    expect(freeLimitNotice({ status: "inactive", plan: "free", lastMeteredCursor: cursor(25) }, 25)?.reached).toBe(true);
  });
  it("paid, pending, under the allowance, already reset, or nothing measured → none", () => {
    expect(freeLimitNotice({ status: "active", plan: "growth", lastMeteredCursor: cursor(300) }, 25)).toBeNull();
    expect(freeLimitNotice({ status: "pending", plan: "free", lastMeteredCursor: cursor(30) }, 25)).toBeNull();
    expect(freeLimitNotice({ status: "active", plan: "free", lastMeteredCursor: cursor(24) }, 25)).toBeNull();
    expect(freeLimitNotice({ status: "active", plan: "free", lastMeteredCursor: cursor(30, "2020-01-01T00:00:00Z") }, 25)).toBeNull();
    expect(freeLimitNotice({ status: "active", plan: "free", lastMeteredCursor: null }, 25)).toBeNull();
  });
});
