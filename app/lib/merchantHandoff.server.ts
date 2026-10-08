import type { McpCall } from "./tenantRead.server";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const OPEN = new Set(["requested", "acknowledged", "active"]);
class HandoffError extends Error {}

export interface MerchantHandoffDeps {
  tenantForShop: (shop: string) => Promise<string | null>;
  call: McpCall;
}
export interface HandoffMessage { id: string; author: string; body: string; at: string | null }
export interface MerchantHandoff {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  requestedAt: string | null;
  messages: HandoffMessage[];
  historyWarning: string | null;
}
export type HandoffRead = { ok: true; handoff: MerchantHandoff } | { ok: false; error: string };
export type HandoffAction = { ok: true; intent: string; message: string } | { ok: false; intent: string; error: string };
export type ConversationRead = { ok: true; messages: HandoffMessage[]; truncated: boolean } | { ok: false; error: string };

async function result(call: McpCall, name: string, args: Obj): Promise<Obj> {
  const response = await call(name, args);
  const data = object(response.data);
  if (!response.ok && /assigned_to_another_operator|assigned to another operator/i.test(response.error ?? "")) {
    throw new HandoffError("Another teammate is handling this conversation. Ask them to finish or release it before replying here.");
  }
  if (!response.ok && /intervention_not_open|intervention is not open/i.test(response.error ?? "")) {
    throw new HandoffError("This request has already been closed. Refresh to see its latest status.");
  }
  if (!response.ok || data.ok !== true || !data.result || typeof data.result !== "object" || Array.isArray(data.result)) {
    throw new HandoffError("The conversation service could not confirm the result. Refresh the conversation before trying again.");
  }
  return object(data.result);
}

// The app's provisioner can administer multiple tenants. Never accept a tenant
// or an agent-session ID from the browser: resolve the authenticated shop and
// prove request membership before reading its history or issuing any write.
async function ownedHandoff(shop: string, requestId: string, deps: MerchantHandoffDeps) {
  if (!shop || !UUID.test(requestId)) throw new HandoffError("This conversation is unavailable. Return to Conversations and select a request.");
  const tenantId = await deps.tenantForShop(shop);
  if (!tenantId) throw new HandoffError("Your assistant is still being set up. Return to Home and finish setup.");
  const listed = await result(deps.call, "list_tenant_interventions", { tenant_id: tenantId, status: "all" });
  if (!Array.isArray(listed.interventions) || !listed.interventions.some((row) => object(row).id === requestId)) {
    throw new HandoffError("This conversation is unavailable for this store. Return to Conversations and refresh the list.");
  }
  const detail = await result(deps.call, "get_tenant_intervention", { tenant_id: tenantId, request_id: requestId });
  const request = object(detail.request);
  if (request.id !== requestId || !text(request.status) || !Array.isArray(detail.messages)) {
    throw new HandoffError("The conversation could not be loaded. Refresh the page and try again.");
  }
  return { tenantId, request, detail };
}

/** Only shopper-visible text, never tool payloads, reasoning or private notes. */
export function handoffHistory(events: unknown, messages: unknown): HandoffMessage[] {
  const rows: HandoffMessage[] = [];
  for (const [index, raw] of (Array.isArray(events) ? events : []).entries()) {
    const event = object(raw);
    if (event.type !== "message.received" && event.type !== "message.completed") continue;
    const data = object(event.data);
    const body = text(data.message);
    if (!body) continue;
    rows.push({ id: `ai-${index}`, author: event.type === "message.received" ? "Customer" : "Assistant", body, at: text(object(event.meta).at) });
  }
  for (const [index, raw] of (Array.isArray(messages) ? messages : []).entries()) {
    const message = object(raw);
    if (!["visitor", "operator", "system"].includes(String(message.sender_kind))) continue;
    const body = text(message.body) ?? (message.event_kind === "operator_joined" ? "A teammate joined the conversation." : message.event_kind === "ai_resumed" ? "The assistant resumed the conversation." : null);
    if (!body) continue;
    rows.push({ id: `human-${text(message.id) ?? index}`, author: message.sender_kind === "visitor" ? "Customer" : message.sender_kind === "operator" ? "Your team" : "Status", body, at: text(message.created_at) });
  }
  return rows.sort((a, b) => (a.at && Number.isFinite(Date.parse(a.at)) ? Date.parse(a.at) : 0) - (b.at && Number.isFinite(Date.parse(b.at)) ? Date.parse(b.at) : 0));
}

export async function loadMerchantHandoff(shop: string, requestId: string, deps: MerchantHandoffDeps): Promise<HandoffRead> {
  try {
    const { tenantId, request, detail } = await ownedHandoff(shop, requestId, deps);
    const agentId = text(request.agent_session_id) ?? text(request.session_id) ?? text(request.sessionId);
    let events: unknown = [];
    let historyWarning: string | null = null;
    if (agentId) {
      try {
        // Bare, deployed MCP shape; never an arbitrary browser-supplied session.
        const history = await result(deps.call, "get_tenant_conversation_transcript", { tenant_id: tenantId, session_id: agentId });
        if (!Array.isArray(history.events)) throw new Error("unreadable history");
        events = history.events;
        if (history.truncated === true) historyWarning = "Some earlier assistant messages are unavailable. The handoff messages below are still available.";
      } catch {
        historyWarning = "Earlier assistant messages could not be loaded. Refresh to try again; you can still read and answer the handoff below.";
      }
    }
    return { ok: true, handoff: {
      id: requestId, title: text(request.title) ?? "Customer conversation", status: String(request.status),
      summary: text(request.summary) ?? text(request.reason), requestedAt: text(request.requested_at),
      messages: handoffHistory(events, detail.messages), historyWarning,
    } };
  } catch (error) {
    return { ok: false, error: error instanceof HandoffError ? error.message : "The conversation could not be loaded. Refresh and try again." };
  }
}

/** AI-only transcripts also remain inside Shopify; the submitted session must
 * match an exact row returned for this shop before the privileged history read. */
export async function loadMerchantConversation(shop: string, sessionId: string, deps: MerchantHandoffDeps): Promise<ConversationRead> {
  try {
    if (!shop || !/^wrun_[A-Za-z0-9_-]{1,120}$/.test(sessionId)) throw new HandoffError("This conversation is unavailable. Return to Conversations and select one.");
    const tenantId = await deps.tenantForShop(shop);
    if (!tenantId) throw new HandoffError("Your assistant is still being set up. Return to Home and finish setup.");
    const listed = await result(deps.call, "list_tenant_conversations", { tenant_id: tenantId, query: sessionId, limit: 200 });
    if (!Array.isArray(listed.conversations) || !listed.conversations.some((row) => object(row).session_id === sessionId)) throw new HandoffError("This conversation is unavailable for this store. Return to Conversations and refresh the list.");
    const history = await result(deps.call, "get_tenant_conversation_transcript", { tenant_id: tenantId, session_id: sessionId });
    if (!Array.isArray(history.events)) throw new HandoffError("The conversation history could not be loaded. Refresh and try again.");
    return { ok: true, messages: handoffHistory(history.events, []), truncated: history.truncated === true };
  } catch (error) {
    return { ok: false, error: error instanceof HandoffError ? error.message : "The conversation could not be loaded. Refresh and try again." };
  }
}

export async function actOnMerchantHandoff(shop: string, requestId: string, form: FormData, deps: MerchantHandoffDeps): Promise<HandoffAction> {
  const intent = typeof form.get("intent") === "string" ? String(form.get("intent")) : "";
  if (!["claim", "reply", "resolve"].includes(intent)) return { ok: false, intent, error: "Choose Claim, Send reply, or Resolve." };
  if (form.get("confirm") !== "yes") return { ok: false, intent, error: "Confirm the action before continuing." };
  const message = typeof form.get("message") === "string" ? String(form.get("message")).trim() : "";
  if (intent === "reply" && (!message || message.length > 4000)) return { ok: false, intent, error: "Write a reply between 1 and 4,000 characters." };
  try {
    const { tenantId, request } = await ownedHandoff(shop, requestId, deps);
    if (!OPEN.has(String(request.status))) return { ok: false, intent, error: "This request is already closed. Refresh to see its latest status." };
    if (intent !== "claim" && request.status !== "active") return { ok: false, intent, error: "Claim the conversation before replying or resolving it." };
    const receipt = await result(deps.call, `${intent}_tenant_intervention`, {
      tenant_id: tenantId, request_id: requestId, ...(intent === "reply" ? { message } : {}), confirm: true,
    });
    const valid = receipt.ok === true && receipt.tenantId === tenantId && receipt.requestId === requestId &&
      (intent === "reply" ? UUID.test(String(receipt.id)) : receipt.id === requestId && receipt.status === (intent === "claim" ? "active" : "resolved"));
    if (!valid) return { ok: false, intent, error: "The action may have completed, but its result could not be confirmed. Refresh before trying again." };
    return { ok: true, intent, message: intent === "claim" ? "Conversation claimed. The assistant is paused while your team answers." : intent === "reply" ? "Reply sent to the conversation." : "Conversation resolved. The assistant can answer the customer's next message." };
  } catch (error) {
    return { ok: false, intent, error: error instanceof HandoffError ? error.message : "The action could not be completed. Refresh and try again." };
  }
}
