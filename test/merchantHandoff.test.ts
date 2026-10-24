import { describe, expect, it, vi } from "vitest";
import { actOnMerchantHandoff, handoffHistory, loadMerchantHandoff, loadMerchantConversation, type MerchantHandoffDeps } from "../app/lib/merchantHandoff.server";
import type { McpCall } from "../app/lib/tenantRead.server";

const SHOP = "merchant.myshopify.com";
const TENANT = "10000000-0000-4000-8000-000000000001";
const ID = "20000000-0000-4000-8000-000000000002";
const OTHER = "30000000-0000-4000-8000-000000000003";
const AGENT = "wrun_01TESTSESSION0001";
const packet = (result: unknown) => ({ ok: true, data: { ok: true, result } });
const ARGS = (session_id: string) => ({ tenant_id: TENANT, session_id, limit: 200 });
// The live default shape of get_tenant_conversation_transcript since busymate-ai-src#2674.
const COMPACT = { session_id: AGENT, messages: [{ role: "customer", at: "2026-10-08T11:59:00Z", text: "Where is my order?" }], total: 1, offset: 0, next_offset: null, running: false, truncated: false };
function fixture(over: { listed?: unknown; request?: Record<string, unknown>; transcript?: unknown; mutate?: unknown; errorTool?: string; errorText?: string } = {}) {
  const call = vi.fn(async (name: string) => {
    if (name === over.errorTool) return { ok: false, error: over.errorText ?? "private backend diagnostic" };
    if (name === "list_tenant_interventions") return packet({ interventions: over.listed ?? [{ id: ID }] });
    if (name === "get_tenant_intervention") return packet({ request: { id: ID, status: "active", agent_session_id: AGENT, title: "Help with delivery", ...over.request }, messages: [{ id: "m", sender_kind: "visitor", body: "A person please", created_at: "2026-10-08T12:00:00Z" }] });
    if (name === "get_tenant_conversation_transcript") return packet(over.transcript ?? COMPACT);
    return packet(over.mutate ?? { ok: true, id: name === "reply_tenant_intervention" ? OTHER : ID, tenantId: TENANT, requestId: ID, status: name === "resolve_tenant_intervention" ? "resolved" : "active" });
  });
  const deps: MerchantHandoffDeps = { tenantForShop: vi.fn(async () => TENANT), call: call as McpCall };
  return { deps, call };
}
function form(intent = "reply", fields: Record<string, string> = {}) {
  const value = new FormData();
  for (const [key, content] of Object.entries({ intent, confirm: "yes", message: "Your parcel is on the way.", ...fields })) value.set(key, content);
  return value;
}

describe("merchant handoff tenant boundary", () => {
  it("resolves only the authenticated shop and pins history to its owned request", async () => {
    const { deps, call } = fixture();
    const read = await loadMerchantHandoff(SHOP, ID, deps);
    expect(read.ok).toBe(true);
    expect(deps.tenantForShop).toHaveBeenCalledWith(SHOP);
    expect(call.mock.calls.map(([name]) => name)).toEqual(["list_tenant_interventions", "get_tenant_intervention", "get_tenant_conversation_transcript"]);
    expect(call).toHaveBeenNthCalledWith(1, "list_tenant_interventions", { tenant_id: TENANT, status: "all" });
    expect(call).toHaveBeenLastCalledWith("get_tenant_conversation_transcript", ARGS(AGENT));
    if (read.ok) expect(read.handoff.messages.map((m) => m.body)).toEqual(["Where is my order?", "A person please"]);
  });
  it.each(["claim", "reply", "resolve"])("rejects another store's request before %s or detail/history reads", async (intent) => {
    const { deps, call } = fixture({ listed: [{ id: OTHER }] });
    expect(await actOnMerchantHandoff(SHOP, ID, form(intent), deps)).toMatchObject({ ok: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(await loadMerchantHandoff(SHOP, ID, deps)).toMatchObject({ ok: false });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("does not trust browser tenant/session/request fields", async () => {
    const { deps, call } = fixture();
    expect(await actOnMerchantHandoff(SHOP, ID, form("reply", { tenant_id: OTHER, session_id: "other-session", request_id: OTHER, shop: "other.myshopify.com" }), deps)).toMatchObject({ ok: true });
    expect(call).toHaveBeenLastCalledWith("reply_tenant_intervention", { tenant_id: TENANT, request_id: ID, message: "Your parcel is on the way.", confirm: true });
  });
  it("fails closed on a mismatched detail receipt", async () => {
    const { deps, call } = fixture({ request: { id: OTHER } });
    expect(await loadMerchantHandoff(SHOP, ID, deps)).toMatchObject({ ok: false });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("unprovisioned or malformed requests never reach the provisioner", async () => {
    const { deps, call } = fixture();
    expect(await loadMerchantHandoff(SHOP, "invalid", deps)).toMatchObject({ ok: false });
    deps.tenantForShop = vi.fn(async () => null);
    expect(await actOnMerchantHandoff(SHOP, ID, form(), deps)).toMatchObject({ ok: false });
    expect(call).not.toHaveBeenCalled();
  });
  it.each(["list_tenant_interventions", "get_tenant_intervention"])("refusal of %s prevents writes", async (errorTool) => {
    const { deps, call } = fixture({ errorTool });
    const result = await actOnMerchantHandoff(SHOP, ID, form(), deps);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private backend diagnostic");
    expect(call.mock.calls.some(([name]) => name === "reply_tenant_intervention")).toBe(false);
  });
});

describe("confirmed handoff actions", () => {
  it.each(["claim", "reply", "resolve"])("requires confirmation for %s", async (intent) => {
    const { deps, call } = fixture();
    expect(await actOnMerchantHandoff(SHOP, ID, form(intent, { confirm: "no" }), deps)).toMatchObject({ ok: false });
    expect(call).not.toHaveBeenCalled();
  });
  it.each(["", " ", "x".repeat(4001)])("rejects an empty or oversized reply", async (message) => {
    const { deps, call } = fixture();
    expect(await actOnMerchantHandoff(SHOP, ID, form("reply", { message }), deps)).toMatchObject({ ok: false });
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects unknown action and non-text message", async () => {
    const { deps, call } = fixture();
    expect(await actOnMerchantHandoff(SHOP, ID, form("delete"), deps)).toMatchObject({ ok: false });
    const file = form(); file.set("message", new Blob(["no"]), "reply.txt");
    expect(await actOnMerchantHandoff(SHOP, ID, file, deps)).toMatchObject({ ok: false });
    expect(call).not.toHaveBeenCalled();
  });
  it.each(["claim", "reply", "resolve"])("confirms exact %s receipt", async (intent) => {
    const { deps, call } = fixture();
    expect(await actOnMerchantHandoff(SHOP, ID, form(intent), deps)).toMatchObject({ ok: true, intent });
    expect(call).toHaveBeenLastCalledWith(`${intent}_tenant_intervention`, expect.objectContaining({ tenant_id: TENANT, request_id: ID, confirm: true }));
  });
  it.each([{ ok: true }, { ok: false }, { ok: true, id: OTHER, tenantId: OTHER, requestId: ID }, { ok: true, id: OTHER, tenantId: TENANT, requestId: OTHER }])("does not mark an uncertain or cross-tenant receipt successful", async (mutate) => {
    const { deps } = fixture({ mutate });
    expect(await actOnMerchantHandoff(SHOP, ID, form(), deps)).toMatchObject({ ok: false });
  });
  it.each(["resolved", "dismissed", "unknown"])("does not mutate a %s request", async (status) => {
    const { deps, call } = fixture({ request: { status } });
    expect(await actOnMerchantHandoff(SHOP, ID, form(), deps)).toMatchObject({ ok: false });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("requires claim before reply or resolve", async () => {
    const { deps, call } = fixture({ request: { status: "requested" } });
    expect(await actOnMerchantHandoff(SHOP, ID, form(), deps)).toMatchObject({ ok: false, error: expect.stringContaining("Claim") });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("keeps service failures in-frame and does not expose backend diagnostics", async () => {
    const { deps } = fixture();
    deps.tenantForShop = async () => { throw new Error("postgres://private-credential"); };
    const result = await actOnMerchantHandoff(SHOP, ID, form(), deps);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private-credential");
  });
  it("explains a separate teammate's claim without leaking backend diagnostics", async () => {
    const { deps } = fixture({ errorTool: "reply_tenant_intervention", errorText: "assigned_to_another_operator: private backend diagnostic" });
    const result = await actOnMerchantHandoff(SHOP, ID, form(), deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Another teammate") });
    expect(JSON.stringify(result)).not.toContain("private backend diagnostic");
  });
});

describe("handoff history", () => {
  it("shows completed public text, not deltas, tool payloads, reasoning or private notes", () => {
    const history = handoffHistory([
      { type: "message.received", data: { message: "Hello" }, meta: { at: "2026-10-08T10:00:00Z" } },
      { type: "message.appended", data: { messageSoFar: "partial" } },
      { type: "action.result", data: { output: "secret" } },
      { type: "session.waiting", data: { continuationToken: "secret" } },
      { type: "message.completed", data: { message: "Hi", reasoning: "private" }, meta: { at: "2026-10-08T10:00:02Z" } },
    ], [{ id: "n", sender_kind: "note", body: "private note" }, { id: "m", sender_kind: "operator", body: "I can help", created_at: "2026-10-08T10:00:03Z" }]);
    expect(history.map((row) => [row.author, row.body])).toEqual([["Customer", "Hello"], ["Assistant", "Hi"], ["Your team", "I can help"]]);
  });
  it("warns honestly when earlier AI history fails while preserving the usable handoff", async () => {
    const { deps } = fixture({ errorTool: "get_tenant_conversation_transcript" });
    const read = await loadMerchantHandoff(SHOP, ID, deps);
    expect(read).toMatchObject({ ok: true, handoff: { historyWarning: expect.stringContaining("could not be loaded") } });
    if (read.ok) expect(read.handoff.messages[0].body).toBe("A person please");
  });
});

describe("ordinary conversation transcripts", () => {
  it("proves exact session ownership before reading a recent conversation", async () => {
    const call = vi.fn(async (name: string) => name === "list_tenant_conversations" ? packet({ conversations: [{ session_id: AGENT }] }) : packet({ ...COMPACT, messages: [] }));
    const deps = { tenantForShop: vi.fn(async () => TENANT), call: call as McpCall };
    expect(await loadMerchantConversation(SHOP, AGENT, deps)).toEqual({ ok: true, messages: [], truncated: false });
    expect(call).toHaveBeenNthCalledWith(1, "list_tenant_conversations", { tenant_id: TENANT, query: AGENT, limit: 200 });
    expect(call).toHaveBeenLastCalledWith("get_tenant_conversation_transcript", ARGS(AGENT));
  });
  it("rejects another tenant or partial-match session before transcript access", async () => {
    const call = vi.fn(async () => packet({ conversations: [{ session_id: `${AGENT}_other` }] }));
    const deps = { tenantForShop: async () => TENANT, call: call as McpCall };
    expect(await loadMerchantConversation(SHOP, AGENT, deps)).toMatchObject({ ok: false });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed sessions without reading tenant or transcript data", async () => {
    const { deps, call } = fixture();
    expect(await loadMerchantConversation(SHOP, "../../other", deps)).toMatchObject({ ok: false });
    expect(deps.tenantForShop).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
  // Reviewer X1 (2026-10-24): every transcript showed "could not be loaded"
  // because the reader required `events`, which the tool only sends for
  // view:"events" since busymate-ai-src#2674.
  const conversationCall = (transcript: unknown) => vi.fn(async (name: string) => name === "list_tenant_conversations" ? packet({ conversations: [{ session_id: AGENT }] }) : packet(transcript));
  it("reads the compact default view: customer, assistant and team lines in order", async () => {
    const call = conversationCall({ ...COMPACT, messages: [
      { role: "customer", at: "2026-10-08T11:59:00Z", text: "Snowboards under $700?" },
      { role: "assistant", at: "2026-10-08T11:59:05Z", text: "The Multi-managed Snowboard is 629.95." },
      { role: "system", at: "2026-10-08T11:59:06Z", text: "internal lifecycle line" },
      { role: "agent", at: "2026-10-08T12:01:00Z", text: "Hi, this is Rita." },
      { role: "assistant", at: "2026-10-08T12:02:00Z", text: "   " },
    ], truncated: true });
    const read = await loadMerchantConversation(SHOP, AGENT, { tenantForShop: async () => TENANT, call: call as McpCall });
    expect(read).toMatchObject({ ok: true, truncated: true });
    if (read.ok) expect(read.messages.map((m) => [m.author, m.body, m.at])).toEqual([
      ["Customer", "Snowboards under $700?", "2026-10-08T11:59:00Z"],
      ["Assistant", "The Multi-managed Snowboard is 629.95.", "2026-10-08T11:59:05Z"],
      ["Your team", "Hi, this is Rita.", "2026-10-08T12:01:00Z"],
    ]);
  });
  it("still reads the raw events replay", async () => {
    const call = conversationCall({ events: [{ type: "message.completed", data: { message: "Hi" }, meta: { at: "2026-10-08T10:00:00Z" } }], truncated: false });
    const read = await loadMerchantConversation(SHOP, AGENT, { tenantForShop: async () => TENANT, call: call as McpCall });
    if (!read.ok) throw new Error(read.error);
    expect(read.messages.map((m) => m.body)).toEqual(["Hi"]);
  });
  it("fails closed with the history message on a result with neither shape", async () => {
    const call = conversationCall({ transcript: { content: "doc" } });
    expect(await loadMerchantConversation(SHOP, AGENT, { tenantForShop: async () => TENANT, call: call as McpCall })).toEqual({ ok: false, error: expect.stringContaining("history could not be loaded") });
  });
});

describe("handoff page with the compact transcript", () => {
  it("shows the assistant chat before the handoff, without a warning, and no duplicate team lines", async () => {
    const { deps } = fixture({ transcript: { ...COMPACT, messages: [
      { role: "customer", at: "2026-10-08T11:58:00Z", text: "What is your return policy?" },
      { role: "assistant", at: "2026-10-08T11:58:30Z", text: "I can connect you with the store's team." },
      { role: "agent", at: "2026-10-08T12:00:30Z", text: "duplicate of the handoff record" },
    ] } });
    const read = await loadMerchantHandoff(SHOP, ID, deps);
    expect(read).toMatchObject({ ok: true, handoff: { historyWarning: null } });
    if (read.ok) expect(read.handoff.messages.map((m) => [m.author, m.body])).toEqual([
      ["Customer", "What is your return policy?"],
      ["Assistant", "I can connect you with the store's team."],
      ["Customer", "A person please"],
    ]);
  });
});
