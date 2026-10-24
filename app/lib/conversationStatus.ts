/**
 * Conversation and handoff status words for the Conversations page (reviewer
 * S6). `list_tenant_conversations` sets `live` only while an assistant turn is
 * executing, so a chat between two shopper messages is `live:false`; showing
 * that as "Ended" was wrong. A storefront chat never formally ends: the status
 * is derived from an open handoff on the same conversation, the running turn
 * and the last activity time.
 */
import type { ConversationRow, HandoffRow } from "./tenantRead.server";

export type StatusTone = "success" | "attention" | "info" | undefined;
export interface StatusLabel { label: string; tone: StatusTone }

/** A conversation with activity inside this window counts as active. */
export const ACTIVE_WINDOW_MS = 30 * 60_000;

const OPEN_HANDOFF = new Set(["requested", "acknowledged", "active"]);

export function handoffStatus(status: string): StatusLabel {
  switch (status) {
    case "requested":
    case "acknowledged":
      return { label: "Waiting for your team", tone: "attention" };
    case "active":
      return { label: "Your team is replying", tone: "info" };
    case "resolved":
      return { label: "Resolved", tone: undefined };
    case "dismissed":
      return { label: "Closed", tone: undefined };
    default:
      return { label: "Unknown", tone: undefined };
  }
}

export function conversationStatus(
  row: Pick<ConversationRow, "sessionId" | "supportSessionId" | "lastActiveAt" | "live">,
  handoffs: readonly Pick<HandoffRow, "sessionId" | "supportSessionId" | "status">[],
  nowMs: number,
): StatusLabel {
  const handoff = handoffs.find((h) => OPEN_HANDOFF.has(h.status) &&
    (h.sessionId === row.sessionId || (h.supportSessionId !== null && h.supportSessionId === row.supportSessionId)));
  if (handoff) return handoffStatus(handoff.status);
  if (row.live) return { label: "Assistant replying", tone: "success" };
  const at = row.lastActiveAt ? Date.parse(row.lastActiveAt) : Number.NaN;
  if (Number.isFinite(at) && nowMs - at < ACTIVE_WINDOW_MS) return { label: "Active", tone: "success" };
  return { label: "Inactive", tone: undefined };
}
