# Merchant conversations inside Shopify

Conversations now opens recent AI transcripts and human handoffs inside the
authenticated Shopify app. A merchant can read a handoff, claim it, reply and
resolve it without a separate Busymate AI account. All staff using this store's
app act as the store's team through its existing application identity.

`app/lib/merchantHandoff.server.ts` uses only `callMcpTool`. Every loader/action
first authenticates with Shopify and resolves the tenant from `session.shop`.
Browser-supplied tenant IDs are never used. An exact tenant-owned intervention
or conversation-list row must exist before detail, transcript or mutation calls.
The agent-session ID for a handoff's history comes from its verified detail.

The deployed MCP read envelopes were verified on 2026-10-08:

- `list_tenant_interventions {tenant_id,status:"all"}` returns
  `{ok:true,result:{interventions:[...]}}`.
- `get_tenant_intervention {tenant_id,request_id}` returns
  `{ok:true,result:{request,messages,...}}`. Its request contains the canonical
  `agent_session_id`, `support_session_id`, status and timestamps.
- `list_tenant_conversations {tenant_id,query,limit}` returns a conversations
  list. Only an exact `session_id` match authorizes the transcript read.
- Bare `get_tenant_conversation_transcript {tenant_id,session_id}` returns
  `{ok:true,result:{events,running,truncated}}`. Only `message.received` and
  `message.completed` text is rendered; deltas, tool payloads, continuation
  tokens, reasoning and private notes are excluded.

Confirmed writes use `claim_tenant_intervention`, `reply_tenant_intervention`
and `resolve_tenant_intervention`. The app validates current state, confirmation,
reply length, and the exact tenant/request mutation receipt. A missing or
uncertain receipt is an error requiring refresh, never a success claim.
The existing MCP implementation owns durable takeover, delivery and resumption.

Validation includes authenticated-route refusal, forged browser ownership,
cross-tenant membership refusal before downstream calls, partial session matches,
invalid confirmations/actions/messages, closed requests, bad receipts, service
failures and safe transcript rendering. Deployment and browser acceptance are
separate: verify claim pauses the assistant, a merchant reply reaches the shopper,
and resolving lets the assistant answer the next message.
