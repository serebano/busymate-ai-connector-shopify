/**
 * Review nit N2 (2026-10-24): Home printed the last-trained time as "08:02 UTC" while
 * Store connection and Conversations show the merchant's local time. The checklist now
 * carries the instant (`at`) and the page renders it through <LocalTime>.
 */
import { describe, expect, it } from "vitest";
import { AT_MARKER, buildSetupChecklist } from "../app/lib/themeEmbed";

const base = {
  provisionState: "published", trainedAt: "2026-10-26T08:37:15Z", trainError: null,
  counts: { products: 13, policies: 1, pages: 2 }, fetched: { products: 17, policies: 1, pages: 2 },
  hasSubscription: true, planId: "starter", embed: "on",
} as unknown as Parameters<typeof buildSetupChecklist>[0];

describe("Home checklist: last-trained time is the merchant's local time", () => {
  it("carries the instant and a marker, not a UTC string", () => {
    const trained = buildSetupChecklist(base).find((s) => s.id === "trained")!;
    expect(trained.at).toBe("2026-10-26T08:37:15Z");
    expect(trained.detail).toContain(`last trained ${AT_MARKER}`);
    expect(trained.detail).not.toMatch(/UTC/);
  });
  it("no instant when not trained", () => {
    const trained = buildSetupChecklist({ ...base, trainedAt: null } as typeof base).find((s) => s.id === "trained")!;
    expect(trained.at).toBeUndefined();
    expect(trained.detail).not.toContain(AT_MARKER);
  });
});
