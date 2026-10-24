import { describe, expect, it } from "vitest";
import { ACTIVE_WINDOW_MS, conversationStatus, handoffStatus } from "../app/lib/conversationStatus";

const NOW = Date.parse("2026-10-24T09:00:00Z");
const row = (over: Partial<{ sessionId: string; supportSessionId: string | null; lastActiveAt: string | null; live: boolean }> = {}) => ({
  sessionId: "wrun_A", supportSessionId: "support-a", lastActiveAt: new Date(NOW - 60_000).toISOString(), live: false, ...over,
});

// Reviewer S6 (2026-10-24): "Ended" was shown for chats that were still going on,
// including one with an open handoff, because `live` only covers a running turn.
describe("conversation status", () => {
  it("a chat between turns is Active, never Ended", () => {
    expect(conversationStatus(row(), [], NOW)).toEqual({ label: "Active", tone: "success" });
  });
  it("a running turn is the assistant replying", () => {
    expect(conversationStatus(row({ live: true, lastActiveAt: null }), [], NOW).label).toBe("Assistant replying");
  });
  it("an open handoff on the same conversation wins", () => {
    expect(conversationStatus(row(), [{ sessionId: "wrun_A", supportSessionId: "support-a", status: "requested" }], NOW)).toEqual({ label: "Waiting for your team", tone: "attention" });
    expect(conversationStatus(row(), [{ sessionId: "wrun_A", supportSessionId: null, status: "active" }], NOW).label).toBe("Your team is replying");
  });
  // Listing walk 2026-10-24: five chats of one visitor share a support session;
  // the handoff named one of them, and all five read "Waiting for your team".
  it("a handoff in another chat of the same visitor does not mark this chat", () => {
    const handoffs = [{ sessionId: "wrun_B", supportSessionId: "support-a", status: "requested" }];
    expect(conversationStatus(row(), handoffs, NOW).label).toBe("Active");
    expect(conversationStatus(row({ sessionId: "wrun_B" }), handoffs, NOW).label).toBe("Waiting for your team");
    expect(conversationStatus(row(), [{ sessionId: null, supportSessionId: "support-a", status: "requested" }], NOW).label).toBe("Active");
  });
  it("a closed handoff or another conversation's handoff does not change the status", () => {
    expect(conversationStatus(row(), [{ sessionId: "wrun_A", supportSessionId: null, status: "resolved" }, { sessionId: "wrun_B", supportSessionId: "support-b", status: "requested" }], NOW).label).toBe("Active");
    expect(conversationStatus(row({ supportSessionId: null }), [{ sessionId: "wrun_B", supportSessionId: null, status: "requested" }], NOW).label).toBe("Active");
  });
  it("quiet past the window, or with no timestamp, is Inactive", () => {
    expect(conversationStatus(row({ lastActiveAt: new Date(NOW - ACTIVE_WINDOW_MS - 1).toISOString() }), [], NOW)).toEqual({ label: "Inactive", tone: undefined });
    expect(conversationStatus(row({ lastActiveAt: null }), [], NOW).label).toBe("Inactive");
    expect(conversationStatus(row({ lastActiveAt: "not a date" }), [], NOW).label).toBe("Inactive");
  });
  it("handoff statuses read as words, not codes", () => {
    expect(["requested", "acknowledged", "active", "resolved", "dismissed", "weird"].map((s) => handoffStatus(s).label))
      .toEqual(["Waiting for your team", "Waiting for your team", "Your team is replying", "Resolved", "Closed", "Unknown"]);
  });
});
