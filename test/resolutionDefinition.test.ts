import { describe, expect, it } from "vitest";
import { RESOLUTION_DEFINITION, REOPEN_WINDOW_MS, decideResolutions } from "../app/lib/resolutionDefinition";
import type { ConversationRow, HandoffRow } from "../app/lib/tenantRead.server";

/**
 * #19 / devtools #2835 — the billable AI-resolution definition (boss default):
 * a visitor conversation the assistant answered that ended WITHOUT a human
 * hand-off, and was NOT reopened by the same visitor within 24h. These tests
 * are the negative control for the review finding ("no qualifying producer") —
 * proving the definition itself, independent of the MCP/ledger plumbing
 * around it (test/resolutionLedger.test.ts).
 */
const NOW = new Date("2026-09-13T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

function conv(over: Partial<ConversationRow> & { sessionId: string }): ConversationRow {
  return { supportSessionId: null, startedAt: null, lastActiveAt: null, live: false, ...over };
}
function handoff(sessionId: string, over: Partial<HandoffRow> = {}): HandoffRow {
  return { id: `int_${sessionId}`, sessionId, supportSessionId: null, status: "requested", reason: null, requestedAt: null, ...over };
}

describe("RESOLUTION_DEFINITION", () => {
  it("is the exact boss-default definition text", () => {
    expect(RESOLUTION_DEFINITION).toBe(
      "A billable AI resolution is a visitor conversation the assistant answered that ended without a human hand-off, and was not reopened by the same visitor within 24 hours.",
    );
  });
  it("the reopen window is exactly 24 hours", () => {
    expect(REOPEN_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("decideResolutions", () => {
  it("billable: ended, no handoff, stable for 24h+", () => {
    const out = decideResolutions([conv({ sessionId: "s1", lastActiveAt: hoursAgo(25) })], [], NOW);
    expect(out).toEqual([{ sessionId: "s1", billable: true, reason: null, occurredAt: hoursAgo(25) }]);
  });

  it("not billable: still live (never ended)", () => {
    const out = decideResolutions([conv({ sessionId: "s1", live: true, lastActiveAt: hoursAgo(48) })], [], NOW);
    expect(out).toEqual([{ sessionId: "s1", billable: false, reason: "live", occurredAt: null }]);
  });

  it("not billable: any hand-off for that session disqualifies it — even a RESOLVED one, not only 'open'", () => {
    const out = decideResolutions([conv({ sessionId: "s1", lastActiveAt: hoursAgo(48) })], [handoff("s1", { status: "resolved" })], NOW);
    expect(out).toEqual([{ sessionId: "s1", billable: false, reason: "handoff", occurredAt: null }]);
  });

  it("not billable: reopened (activity) inside the 24h window — right at the boundary", () => {
    const out = decideResolutions(
      [conv({ sessionId: "s1", lastActiveAt: hoursAgo(23.999) }), conv({ sessionId: "s2", lastActiveAt: hoursAgo(24.001) })],
      [],
      NOW,
    );
    expect(out.find((d) => d.sessionId === "s1")).toMatchObject({ billable: false, reason: "within-reopen-window" });
    expect(out.find((d) => d.sessionId === "s2")).toMatchObject({ billable: true });
  });

  it("fails closed: no readable lastActiveAt is never counted", () => {
    const out = decideResolutions([conv({ sessionId: "s1", lastActiveAt: null })], [], NOW);
    expect(out).toEqual([{ sessionId: "s1", billable: false, reason: "no-last-active", occurredAt: null }]);
  });

  it("a hand-off on a DIFFERENT session does not disqualify this one", () => {
    const out = decideResolutions([conv({ sessionId: "s1", lastActiveAt: hoursAgo(30) })], [handoff("other")], NOW);
    expect(out[0]).toMatchObject({ billable: true });
  });
});
