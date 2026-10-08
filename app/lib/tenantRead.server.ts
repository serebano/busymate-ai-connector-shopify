/**
 * Read-side tenant helpers for the embedded admin — branding (Assistant
 * settings), recent conversations + open human handoffs (Conversations page,
 * App Store Req 5.1.5 "send collected data back to the merchant").
 *
 * ALL-OPS-VIA-MCP: every read is a Busymate AI MCP tool call through
 * `callMcpTool` (app/bmai.server.ts) with the app's own provisioner identity,
 * which `provision_partner_tenant` homes as each partner tenant's admin member —
 * the identity `list_tenant_conversations` / `list_tenant_interventions` /
 * `get_tenant` authorize. Never a backdoor DB read. Every refusal is surfaced
 * (`ok:false` + error), never rendered as "no conversations".
 *
 * Tool result shapes below were captured live on busymate.ai/mcp (2026-09-02).
 */
import { callMcpTool, type McpResult } from "../bmai.server";

export type McpCall = <T = unknown>(name: string, args: Record<string, unknown>) => Promise<McpResult<T>>;

export interface ConversationRow {
  sessionId: string;
  supportSessionId: string | null;
  startedAt: string | null;
  lastActiveAt: string | null;
  live: boolean;
}

export interface HandoffRow {
  id: string;
  /** Agent conversation id; legacy responses called this session_id. */
  sessionId: string | null;
  /** Visitor support session, distinct from the agent conversation. */
  supportSessionId: string | null;
  status: string;
  reason: string | null;
  requestedAt: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const sessionId = (v: unknown): string | null => str(v)?.trim() || null;

/** `{ ok, result: { conversations: [{ session_id, support_session_id, created_at, last_active_at, live }] } }` */
export function conversationRows(data: unknown): ConversationRow[] {
  const list = obj(obj(data).result).conversations;
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => obj(c))
    .filter((c) => str(c.session_id))
    .map((c) => ({
      sessionId: String(c.session_id),
      supportSessionId: str(c.support_session_id),
      startedAt: str(c.created_at),
      lastActiveAt: str(c.last_active_at),
      live: c.live === true,
    }));
}

/** Current interventions carry agent_session_id + support_session_id; retain legacy aliases. */
export function handoffRows(data: unknown): HandoffRow[] {
  const list = obj(obj(data).result).interventions;
  if (!Array.isArray(list)) return [];
  return list
    .map((i) => obj(i))
    .filter((i) => str(i.id))
    .map((i) => ({
      id: String(i.id),
      sessionId: sessionId(i.agent_session_id) ?? sessionId(i.session_id) ?? sessionId(i.sessionId),
      supportSessionId: sessionId(i.support_session_id),
      status: str(i.status) ?? "requested",
      reason: str(i.reason) ?? str(i.summary),
      requestedAt: str(i.requested_at) ?? str(i.created_at),
    }));
}

export interface ListResult<T> {
  ok: boolean;
  rows: T[];
  error?: string;
}

const NOT_PROVISIONED = "no provisioned tenant for this shop yet";

export async function listTenantConversations(
  tenantId: string | null | undefined,
  limit = 25,
  call: McpCall = callMcpTool,
): Promise<ListResult<ConversationRow>> {
  if (!tenantId) return { ok: false, rows: [], error: NOT_PROVISIONED };
  const r = await call("list_tenant_conversations", { tenant_id: tenantId, limit });
  if (!r.ok) return { ok: false, rows: [], error: `list_tenant_conversations: ${r.error ?? "refused"}` };
  return { ok: true, rows: conversationRows(r.data) };
}

export async function listTenantHandoffs(
  tenantId: string | null | undefined,
  call: McpCall = callMcpTool,
): Promise<ListResult<HandoffRow>> {
  if (!tenantId) return { ok: false, rows: [], error: NOT_PROVISIONED };
  const r = await call("list_tenant_interventions", { tenant_id: tenantId, status: "open" });
  if (!r.ok) return { ok: false, rows: [], error: `list_tenant_interventions: ${r.error ?? "refused"}` };
  return { ok: true, rows: handoffRows(r.data) };
}

/**
 * ALL handoffs (explicit all status), any lifecycle — used by the resolution meter
 * (app/lib/resolutionLedger.server.ts): a conversation that ever had a human
 * intervention requested (open, resolved, or declined) is disqualified from the
 * "no hand-off" billable-resolution definition, not just a currently-open one.
 * Distinct from `listTenantHandoffs` (open-only, the Conversations-page inbox).
 */
export async function listTenantInterventionsAll(
  tenantId: string | null | undefined,
  call: McpCall = callMcpTool,
): Promise<ListResult<HandoffRow>> {
  if (!tenantId) return { ok: false, rows: [], error: NOT_PROVISIONED };
  const r = await call("list_tenant_interventions", { tenant_id: tenantId, status: "all" });
  if (!r.ok) return { ok: false, rows: [], error: `list_tenant_interventions: ${r.error ?? "refused"}` };
  return { ok: true, rows: handoffRows(r.data) };
}

export type BrandingRead =
  | { ok: true; assistantName: string | null; productName: string | null }
  | { ok: false; error: string };

/** `get_tenant` → `{ ok, tenant: { branding: { productName, assistantName } } }` */
export async function readTenantBranding(
  tenantId: string | null | undefined,
  call: McpCall = callMcpTool,
): Promise<BrandingRead> {
  if (!tenantId) return { ok: false, error: NOT_PROVISIONED };
  const r = await call("get_tenant", { tenant_id: tenantId });
  if (!r.ok) return { ok: false, error: `get_tenant: ${r.error ?? "refused"}` };
  const branding = obj(obj(obj(r.data).tenant).branding);
  return { ok: true, assistantName: str(branding.assistantName), productName: str(branding.productName) };
}
