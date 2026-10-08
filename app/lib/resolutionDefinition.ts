/**
 * THE billable AI-resolution definition (#19 / devtools #2835 — boss default,
 * recorded here + docs/BILLING.md as the single source of truth):
 *
 *   A billable AI resolution is a visitor conversation the assistant answered
 *   that ended WITHOUT a human hand-off, and was NOT reopened by the same
 *   visitor within 24 hours.
 *
 * Pure, dependency-free (no MCP, no Prisma) so the definition itself is
 * unit-tested in isolation from the read/idempotency plumbing around it
 * (app/lib/resolutionLedger.server.ts).
 *
 * Inputs are the two MCP-sourced view-models already used by the Conversations
 * page (app/lib/tenantRead.server.ts): `ConversationRow` (session lifecycle) and
 * `HandoffRow` (human-intervention requests, ANY status — a resolved/declined
 * handoff still means a human touched the conversation, so it is never counted).
 *
 * "Not reopened within 24h" is derived from a SINGLE snapshot, not a diff across
 * runs: `lastActiveAt` only ever advances when the visitor (or the assistant)
 * adds another turn to that same session, so "no activity in the last 24h" and
 * "not reopened within 24h of ending" are the same fact. A conversation still
 * inside that 24h window is simply not yet decidable and is re-checked on the
 * next scan — never guessed either way.
 */
import type { ConversationRow, HandoffRow } from "./tenantRead.server";

export const RESOLUTION_DEFINITION =
  "A billable AI resolution is a visitor conversation the assistant answered that ended without a human hand-off, and was not reopened by the same visitor within 24 hours.";

export const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ResolutionDecision {
  sessionId: string;
  /** True once this conversation is DEFINITELY billable (never a guess). */
  billable: boolean;
  /** Why not (when `billable` is false) — for observability, never shown as billed. */
  reason: "live" | "handoff" | "within-reopen-window" | "no-last-active" | null;
  /** The instant it qualified — the ledger's `occurredAt` (session `lastActiveAt`), not now(). */
  occurredAt: string | null;
}

/**
 * Decide every conversation in one snapshot. Fails CLOSED per-row: a
 * conversation with no readable `lastActiveAt` is never counted (never a
 * fabricated resolution), same spirit as the rest of this app's MCP reads.
 */
export function decideResolutions(
  conversations: readonly ConversationRow[],
  handoffs: readonly HandoffRow[],
  now: Date = new Date(),
): ResolutionDecision[] {
  const handedOff = new Set(handoffs.map((h) => h.sessionId).filter((id): id is string => Boolean(id)));
  // Older/system requests may have only the visitor session. Keep its namespace
  // separate; an exact agent binding must not exclude another conversation.
  const supportHandedOff = new Set(handoffs.filter((h) => !h.sessionId)
    .map((h) => h.supportSessionId).filter((id): id is string => Boolean(id)));
  return conversations.map((c) => {
    if (c.live) return { sessionId: c.sessionId, billable: false, reason: "live", occurredAt: null };
    if (handedOff.has(c.sessionId) || (c.supportSessionId && supportHandedOff.has(c.supportSessionId))) {
      return { sessionId: c.sessionId, billable: false, reason: "handoff", occurredAt: null };
    }
    if (!c.lastActiveAt) return { sessionId: c.sessionId, billable: false, reason: "no-last-active", occurredAt: null };
    const lastActive = Date.parse(c.lastActiveAt);
    if (!Number.isFinite(lastActive)) return { sessionId: c.sessionId, billable: false, reason: "no-last-active", occurredAt: null };
    if (now.getTime() - lastActive < REOPEN_WINDOW_MS) {
      return { sessionId: c.sessionId, billable: false, reason: "within-reopen-window", occurredAt: null };
    }
    return { sessionId: c.sessionId, billable: true, reason: null, occurredAt: c.lastActiveAt };
  });
}
