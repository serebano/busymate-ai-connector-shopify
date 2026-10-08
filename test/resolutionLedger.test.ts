import { describe, expect, it, vi } from "vitest";
import { evidenceRefFor, isTenantManagementDenied, readNewResolutions, type ResolutionLedgerDeps } from "../app/lib/resolutionLedger.server";
import { conversationRows, handoffRows, type ConversationRow, type HandoffRow } from "../app/lib/tenantRead.server";

/**
 * The producer (#19/#2835): conversation + hand-off MCP reads → the
 * billable-resolution definition → idempotent-per-conversation-id counting.
 * `commitCountedResolutions` itself (the Prisma write) is exercised live by
 * `test/integration/meterOutbox.mjs`-style DB scenarios, not here — this file
 * proves the orchestration + retry-safe batch identity with injected deps.
 */
const NOW = new Date("2026-09-13T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

function conv(sessionId: string, lastActiveAt: string, live = false): ConversationRow {
  return { sessionId, supportSessionId: null, startedAt: null, lastActiveAt, live };
}

function deps(over: Partial<ResolutionLedgerDeps> & { alreadyCountedIds?: string[] } = {}): ResolutionLedgerDeps {
  const already = new Set(over.alreadyCountedIds ?? []);
  return {
    listConversations: over.listConversations ?? (async () => ({ ok: true, rows: [] })),
    listHandoffs: over.listHandoffs ?? (async () => ({ ok: true, rows: [] })),
    alreadyCounted: over.alreadyCounted ?? (async (_tenantId, ids) => new Set(ids.filter((id) => already.has(id)))),
    markTenantReachability: over.markTenantReachability ?? (async () => ({ changed: false })),
    now: over.now ?? (() => NOW),
  };
}

describe("readNewResolutions", () => {
  it("counts a clean ended-no-handoff-stable conversation and returns its exact session for commit", async () => {
    const conversations: ConversationRow[] = [conv("s1", hoursAgo(30))];
    const out = await readNewResolutions("t_1", deps({ listConversations: async () => ({ ok: true, rows: conversations }) }));
    expect(out).toMatchObject({ resolutions: 1, occurredFrom: hoursAgo(30), occurredThrough: hoursAgo(30) });
    expect(out?.sessions).toEqual([{ sessionId: "s1", occurredAt: hoursAgo(30) }]);
    expect(out?.cursor).toBe(evidenceRefFor(["s1"]));
  });

  it("excludes handed-off and still-reopenable conversations from the count", async () => {
    const conversations: ConversationRow[] = [conv("billable", hoursAgo(30)), conv("handed-off", hoursAgo(30)), conv("too-recent", hoursAgo(1))];
    const handoffs: HandoffRow[] = [{ id: "i1", sessionId: "handed-off", supportSessionId: null, status: "resolved", reason: null, requestedAt: null }];
    const out = await readNewResolutions(
      "t_1",
      deps({ listConversations: async () => ({ ok: true, rows: conversations }), listHandoffs: async () => ({ ok: true, rows: handoffs }) }),
    );
    expect(out?.resolutions).toBe(1);
    expect(out?.sessions.map((s) => s.sessionId)).toEqual(["billable"]);
  });

  it("idempotent per conversation id: a session already in the ledger is never recounted", async () => {
    const conversations: ConversationRow[] = [conv("s1", hoursAgo(30)), conv("s2", hoursAgo(30))];
    const out = await readNewResolutions(
      "t_1",
      deps({ listConversations: async () => ({ ok: true, rows: conversations }), alreadyCountedIds: ["s1"] }),
    );
    expect(out?.resolutions).toBe(1);
    expect(out?.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("excludes current MCP handoff bindings, including closed and support-only requests", async () => {
    const conversations = conversationRows({ result: { conversations: [
      { session_id: "wrun_current", support_session_id: "visitor-shared", last_active_at: hoursAgo(30) },
      { session_id: "wrun_next", support_session_id: "visitor-shared", last_active_at: hoursAgo(30) },
      { session_id: "wrun_support_only", support_session_id: "visitor-support-only", last_active_at: hoursAgo(30) },
      { session_id: "wrun_unrelated", support_session_id: "visitor-other", last_active_at: hoursAgo(30) },
      { session_id: "wrun_no_visitor", last_active_at: hoursAgo(30) },
    ] } });
    const handoffs = handoffRows({ ok: true, result: { interventions: [
      { id: "resolved", agent_session_id: "wrun_current", support_session_id: "visitor-shared", status: "resolved" },
      { id: "dismissed", agent_session_id: null, support_session_id: "visitor-support-only", status: "dismissed" },
      { id: "unbound", agent_session_id: "", support_session_id: null, status: "requested" },
    ] } });
    const out = await readNewResolutions("t_1", deps({
      listConversations: async () => ({ ok: true, rows: conversations }),
      listHandoffs: async () => ({ ok: true, rows: handoffs }),
    }));
    expect(out?.sessions.map((s) => s.sessionId)).toEqual(["wrun_next", "wrun_unrelated", "wrun_no_visitor"]);
    expect(out?.resolutions).toBe(3);
  });

  it("STABLE cursor across retries of the identical undecided batch (never a wall-clock value)", async () => {
    const conversations: ConversationRow[] = [conv("s1", hoursAgo(30))];
    const d = deps({ listConversations: async () => ({ ok: true, rows: conversations }) });
    const first = await readNewResolutions("t_1", d);
    const second = await readNewResolutions("t_1", d); // same deps, same "already counted" state (not yet committed)
    expect(first?.cursor).toBe(second?.cursor);
    expect(first?.cursor).toBe(evidenceRefFor(["s1"]));
  });

  it("fails closed (null) when either MCP read is refused for an UNKNOWN reason — never a fabricated zero", async () => {
    expect(await readNewResolutions("t_1", deps({ listConversations: async () => ({ ok: false, rows: [], error: "network timeout" } as never) }))).toBeNull();
    expect(await readNewResolutions("t_1", deps({ listHandoffs: async () => ({ ok: false, rows: [], error: "500" } as never) }))).toBeNull();
  });

  // #19/#2835 — a deprovisioned/archived tenant is a KNOWN, stable condition
  // (the platform denies this app's stored admin identity on that tenant),
  // never a transient error: quiet zero, not "unreadable", and logged only on
  // the FIRST transition — not every hourly run.
  describe("deprovisioned tenant (tenant_management_denied) — quiet skip", () => {
    it("returns a quiet zero batch, never null/'unreadable'", async () => {
      const out = await readNewResolutions(
        "t_1",
        deps({ listConversations: async () => ({ ok: false, rows: [], error: "list_tenant_conversations: list_support_conversations refused: tenant_management_denied" } as never) }),
      );
      expect(out).toEqual({ resolutions: 0, cursor: evidenceRefFor([]), occurredFrom: null, occurredThrough: null, evidenceRef: null, sessions: [] });
    });

    it("marks the tenant unreachable (true) exactly once — the handoffs read is never attempted", async () => {
      const listHandoffs = vi.fn(async () => ({ ok: true, rows: [] as HandoffRow[] }));
      const markTenantReachability = vi.fn(async () => ({ changed: true }));
      await readNewResolutions(
        "t_1",
        deps({ listConversations: async () => ({ ok: false, rows: [], error: "tenant_management_denied" } as never), listHandoffs, markTenantReachability }),
      );
      expect(markTenantReachability).toHaveBeenCalledWith("t_1", true);
      expect(listHandoffs).not.toHaveBeenCalled();
    });

    it("a SECOND consecutive denial is still a quiet zero, but marks nothing NEW (changed:false) — the caller logs only on the transition", async () => {
      const markTenantReachability = vi.fn(async () => ({ changed: false })); // already marked unreachable from a prior run
      const out = await readNewResolutions(
        "t_1",
        deps({ listConversations: async () => ({ ok: false, rows: [], error: "tenant_management_denied" } as never), markTenantReachability }),
      );
      expect(out?.resolutions).toBe(0);
      expect(markTenantReachability).toHaveBeenCalledWith("t_1", true);
    });

    it("a successful read after a denial clears reachability (false)", async () => {
      const markTenantReachability = vi.fn(async () => ({ changed: true }));
      await readNewResolutions("t_1", deps({ markTenantReachability }));
      expect(markTenantReachability).toHaveBeenCalledWith("t_1", false);
    });

    it("handoffs denied (conversations fine) is ALSO a quiet skip, not a partial/fabricated count", async () => {
      const out = await readNewResolutions(
        "t_1",
        deps({
          listConversations: async () => ({ ok: true, rows: [conv("s1", hoursAgo(30))] }),
          listHandoffs: async () => ({ ok: false, rows: [], error: "tenant_management_denied" } as never),
        }),
      );
      expect(out).toMatchObject({ resolutions: 0, sessions: [] });
    });
  });

  describe("isTenantManagementDenied", () => {
    it("matches the exact live MCP denial substring", () => {
      expect(isTenantManagementDenied("list_tenant_conversations: list_support_conversations refused: tenant_management_denied")).toBe(true);
    });
    it("does not match an unrelated error or undefined", () => {
      expect(isTenantManagementDenied("network timeout")).toBe(false);
      expect(isTenantManagementDenied(undefined)).toBe(false);
    });
  });

  // Incident 2026-09-13: the two MCP reads share ONE rotating refresh credential;
  // issuing them concurrently on a cold cache raced the refresh grant and got the
  // token family revoked. They must be SEQUENTIAL — handoffs only after
  // conversations resolved, and never at all when conversations are unreadable.
  it("reads conversations then handoffs SEQUENTIALLY (never concurrently)", async () => {
    const order: string[] = [];
    let releaseConv!: () => void;
    const convGate = new Promise<void>((r) => { releaseConv = r; });
    const d = deps({
      listConversations: async () => { order.push("conv:start"); await convGate; order.push("conv:end"); return { ok: true, rows: [] }; },
      listHandoffs: async () => { order.push("handoffs:start"); return { ok: true, rows: [] }; },
    });
    const run = readNewResolutions("t_1", d);
    await Promise.resolve();
    expect(order).toEqual(["conv:start"]); // handoffs NOT started while conversations is in flight
    releaseConv();
    await run;
    expect(order).toEqual(["conv:start", "conv:end", "handoffs:start"]);
  });

  it("skips the handoffs read entirely when conversations are unreadable", async () => {
    const listHandoffs = vi.fn(async () => ({ ok: true, rows: [] as HandoffRow[] }));
    expect(await readNewResolutions("t_1", deps({ listConversations: async () => ({ ok: false, rows: [] }), listHandoffs }))).toBeNull();
    expect(listHandoffs).not.toHaveBeenCalled();
  });

  it("zero billable conversations ⇒ resolutions 0, no sessions to commit", async () => {
    const out = await readNewResolutions("t_1", deps());
    expect(out).toMatchObject({ resolutions: 0, sessions: [], occurredFrom: null, occurredThrough: null, evidenceRef: null });
  });

  it("occurredFrom/occurredThrough span the earliest/latest counted session", async () => {
    const conversations: ConversationRow[] = [conv("s1", hoursAgo(48)), conv("s2", hoursAgo(30))];
    const out = await readNewResolutions("t_1", deps({ listConversations: async () => ({ ok: true, rows: conversations }) }));
    expect(out).toMatchObject({ resolutions: 2, occurredFrom: hoursAgo(48), occurredThrough: hoursAgo(30) });
  });
});

describe("evidenceRefFor", () => {
  it("is order-independent (a stable set identity)", () => {
    expect(evidenceRefFor(["b", "a"])).toBe(evidenceRefFor(["a", "b"]));
  });
  it("differs for a different set", () => {
    expect(evidenceRefFor(["a"])).not.toBe(evidenceRefFor(["a", "b"]));
  });
});
