import { describe, expect, it, vi } from "vitest";
import {
  conversationRows,
  handoffRows,
  listTenantConversations,
  listTenantHandoffs,
  listTenantInterventionsAll,
  readTenantBranding,
  type McpCall,
} from "../app/lib/tenantRead.server";

/**
 * Req 5.1.5 — the merchant sees the data the app collects: recent conversations
 * + open human handoffs, read over the Busymate AI MCP tools
 * (list_tenant_conversations / list_tenant_interventions) — never a backdoor read.
 * The exact structuredContent shapes below were captured live on busymate.ai/mcp.
 */
const LIVE_CONVERSATIONS = {
  ok: true,
  result: {
    conversations: [
      { session_id: "wrun_01ABC", support_session_id: "2ef3dc09-e9cd-41b3-97c0-d4d480b4802f", created_at: "2026-09-02T08:54:06.354Z", last_active_at: "2026-09-02T08:55:06.354Z", live: true },
      { session_id: "wrun_01DEF", support_session_id: "6f883078-d74c-43e3-b9c7-0d45f0ffa01e", created_at: "2026-08-31T08:42:54.023Z", last_active_at: "2026-08-31T08:42:54.369Z", live: false },
    ],
  },
};
const LIVE_INTERVENTIONS = {
  ok: true,
  result: {
    interventions: [
      { id: "int_1", session_id: "wrun_01ABC", status: "requested", reason: "customer asked for a human", requested_at: "2026-09-02T08:55:00Z" },
    ],
    interventionDeliveries: [],
    operatorRoster: [{ user_id: "u1", role_key: "t:x:admin", availability: "offline" }],
  },
};

function call(map: Record<string, unknown>): McpCall {
  return vi.fn(async (name: string) => (name in map ? { ok: true, data: map[name] } : { ok: false, error: `unknown ${name}` })) as unknown as McpCall;
}

describe("listTenantConversations", () => {
  it("calls list_tenant_conversations with tenant_id + limit and returns rows newest first", async () => {
    const c = call({ list_tenant_conversations: LIVE_CONVERSATIONS });
    const out = await listTenantConversations("t_1", 25, c);
    expect(c).toHaveBeenCalledWith("list_tenant_conversations", { tenant_id: "t_1", limit: 25 });
    expect(out.ok).toBe(true);
    expect(out.rows.map((r) => r.sessionId)).toEqual(["wrun_01ABC", "wrun_01DEF"]);
    expect(out.rows[0]).toMatchObject({ live: true, startedAt: "2026-09-02T08:54:06.354Z", lastActiveAt: "2026-09-02T08:55:06.354Z" });
  });
  it("a refused call is an error the page shows (never an empty 'no conversations')", async () => {
    const out = await listTenantConversations("t_1", 25, call({}));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/list_tenant_conversations/);
    expect(out.rows).toEqual([]);
  });
  it("no tenant ⇒ not-provisioned error without calling MCP", async () => {
    const c = call({});
    const out = await listTenantConversations(null, 25, c);
    expect(out.ok).toBe(false);
    expect(c).not.toHaveBeenCalled();
  });
});

describe("listTenantHandoffs", () => {
  it("reads the open intervention queue", async () => {
    const c = call({ list_tenant_interventions: LIVE_INTERVENTIONS });
    const out = await listTenantHandoffs("t_1", c);
    expect(c).toHaveBeenCalledWith("list_tenant_interventions", { tenant_id: "t_1", status: "open" });
    expect(out.ok).toBe(true);
    expect(out.rows).toEqual([{ id: "int_1", sessionId: "wrun_01ABC", supportSessionId: null, status: "requested", reason: "customer asked for a human", requestedAt: "2026-09-02T08:55:00Z" }]);
  });
  it("explicitly includes resolved and dismissed handoffs for resolution billing", async () => {
    const c = call({ list_tenant_interventions: LIVE_INTERVENTIONS });
    const out = await listTenantInterventionsAll("t_1", c);
    expect(c).toHaveBeenCalledWith("list_tenant_interventions", { tenant_id: "t_1", status: "all" });
    expect(out.ok).toBe(true);
    expect(out.rows[0].sessionId).toBe("wrun_01ABC");
  });
});

describe("row view-models", () => {
  it("conversationRows tolerates missing fields", () => {
    expect(conversationRows({ result: { conversations: [{ session_id: "s" }] } })).toEqual([
      { sessionId: "s", supportSessionId: null, startedAt: null, lastActiveAt: null, live: false },
    ]);
    expect(conversationRows(null)).toEqual([]);
  });
  it("handoffRows tolerates missing fields", () => {
    expect(handoffRows({ result: { interventions: [{ id: "i" }] } })).toEqual([{ id: "i", sessionId: null, supportSessionId: null, status: "requested", reason: null, requestedAt: null }]);
  });
  it("keeps current agent and support bindings distinct and prefers the canonical agent id", () => {
    const rows = handoffRows({ ok: true, result: { interventions: [{
      id: "current", agent_session_id: "wrun_current", support_session_id: "visitor-session",
      session_id: "obsolete", sessionId: "also-obsolete", status: "requested", summary: "Shopper requested a person",
      requested_at: "2026-10-08T11:54:58Z",
    }] } });
    expect(rows).toEqual([{ id: "current", sessionId: "wrun_current", supportSessionId: "visitor-session",
      status: "requested", reason: "Shopper requested a person", requestedAt: "2026-10-08T11:54:58Z" }]);
  });
  it("supports agent-only, support-only, legacy, and malformed optional bindings", () => {
    const rows = handoffRows({ result: { interventions: [
      { id: "agent", agent_session_id: "wrun_agent" },
      { id: "support", support_session_id: "visitor-session" },
      { id: "legacy", sessionId: "wrun_legacy" },
      { id: "fallback", agent_session_id: 42, session_id: "wrun_fallback", support_session_id: [] },
      { id: "empty", agent_session_id: "  ", session_id: null, support_session_id: "" },
    ] } });
    expect(rows.map(({ sessionId, supportSessionId }) => [sessionId, supportSessionId])).toEqual([
      ["wrun_agent", null], [null, "visitor-session"], ["wrun_legacy", null], ["wrun_fallback", null], [null, null],
    ]);
  });
});

describe("readTenantBranding (settings load)", () => {
  it("reads assistantName/productName from get_tenant", async () => {
    const c = call({ get_tenant: { ok: true, tenant: { id: "t_1", branding: { productName: "Acme", assistantName: "bro" } } } });
    expect(await readTenantBranding("t_1", c)).toEqual({ ok: true, assistantName: "bro", productName: "Acme" });
    expect(c).toHaveBeenCalledWith("get_tenant", { tenant_id: "t_1" });
  });
  it("fails closed when the tenant is missing or the read is refused", async () => {
    expect(await readTenantBranding(null, call({}))).toMatchObject({ ok: false });
    expect(await readTenantBranding("t_1", call({}))).toMatchObject({ ok: false });
  });
});
