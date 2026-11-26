import { expect, it } from "vitest";
import { measuredCycleResolutions } from "../app/lib/usageDisplay";
import { serializeMeterCursor } from "../app/lib/meterCursor";

it("distinguishes an observed zero from missing or failed usage", () => {
  const zero = serializeMeterCursor({ cursor: "c", cycleKey: "cycle", cycleResolutions: 0 });
  expect(measuredCycleResolutions(zero)).toBe(0);
  expect(measuredCycleResolutions(zero, "unreadable")).toBeNull();
  expect(measuredCycleResolutions(null)).toBeNull();
  expect(measuredCycleResolutions("legacy")).toBeNull();
  expect(measuredCycleResolutions('{"v":1,"cycleKey":"cycle"}')).toBeNull();
  expect(measuredCycleResolutions(serializeMeterCursor({ cursor: "c", cycleKey: "cycle", cycleResolutions: 17 }))).toBe(17);
});

it("a ZERO-USAGE store (never resolved anything, or Free-plan, or a fresh cycle) renders 0, never 'unavailable' (#19/#2835)", () => {
  // This is the EXACT shape meterShop actually persists for a zero-resolution
  // batch: `cycleKey` stays null (only the Free-plan and paid-cycle-fetch
  // branches ever populate it, and neither runs when `resolutions === 0`).
  const noCycleKeyZero = serializeMeterCursor({ cursor: "c1", cycleKey: null, cycleResolutions: 0 });
  expect(measuredCycleResolutions(noCycleKeyZero)).toBe(0);
  // Same shape but a real nonzero count (a Free-plan store that has resolved
  // something, but never went through a paid-cycle fetch) must also render.
  const noCycleKeyNonzero = serializeMeterCursor({ cursor: "c1", cycleKey: null, cycleResolutions: 3 });
  expect(measuredCycleResolutions(noCycleKeyNonzero)).toBe(3);
});

it("after a cycle rollover the Billing page shows the CURRENT cycle (0), never last cycle's count", () => {
  // review-test-7, 2026-11-26: stored cycle 2026-10-23 with 16 used, Shopify's live cycle started 2026-11-22.
  const stale = serializeMeterCursor({ cursor: "c", cycleKey: "2026-10-23T17:36:35Z", cycleResolutions: 16 });
  expect(measuredCycleResolutions(stale, null, "2026-11-22T17:36:35Z")).toBe(0);
  // Same cycle, or no live cycle known (trial / Partner API unread / no plan): the stored count.
  expect(measuredCycleResolutions(stale, null, "2026-10-23T17:36:35Z")).toBe(16);
  expect(measuredCycleResolutions(stale, null, null)).toBe(16);
  // The trial counter belongs to no paid cycle: once the first cycle opens it reads 0.
  const trial = serializeMeterCursor({ cursor: "c", cycleKey: "trial:2026-10-23T17:36:35Z", cycleResolutions: 9, cycleReported: 0 });
  expect(measuredCycleResolutions(trial, null, null)).toBe(9);
  expect(measuredCycleResolutions(trial, null, "2026-10-23T17:36:35Z")).toBe(0);
  // A failed meter run is still "unavailable", never a guessed 0.
  expect(measuredCycleResolutions(stale, "unreadable", "2026-11-22T17:36:35Z")).toBeNull();
});
