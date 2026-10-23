import type { RuntimeReadiness } from "./runtimeReadiness";

/**
 * The Store connection card's status, pure (busymate-ai-src#2624 reviewer W12).
 *
 * Re-train and Reconnect re-publish the assistant, and for a few seconds (longer
 * when two publishes overlap) the runtime reads `pending`: desired revision ahead
 * of the applied one. The live assistant keeps serving the previous revision the
 * whole time, so the connection IS working — the card must say Connected
 * ("updating"), never "Not connected", and the page must re-read by itself until
 * the runtime settles (`recheck`). Before this, the page showed the pending
 * snapshot taken right after the action and never re-read it.
 *
 * `unverified` (a read that timed out or failed) is "Checking", also re-read;
 * only a definite error / orphaned / never-provisioned state is not connected.
 */
export interface ConnectionView {
  readonly connected: boolean;
  readonly badge: { readonly tone: "success" | "info" | "attention" | "critical"; readonly label: string };
  readonly note: string | null;
  readonly noteTone: "subdued" | "caution";
  readonly recheck: boolean;
}

export function connectionView(input: {
  connectorId: string | null;
  provisionState: string;
  provisionWarning: string | null;
  runtime: RuntimeReadiness["state"] | null;
}): ConnectionView {
  const registered = Boolean(input.connectorId) && !input.provisionWarning;
  if (input.provisionState === "error") {
    return { connected: false, badge: { tone: "critical", label: "Error" }, note: null, noteTone: "caution", recheck: false };
  }
  if (registered && input.runtime === "ready") {
    return { connected: true, badge: { tone: "success", label: "Connected" }, note: null, noteTone: "subdued", recheck: false };
  }
  if (registered && input.runtime === "pending") {
    return {
      connected: true,
      badge: { tone: "success", label: "Connected" },
      note: "Applying your latest changes. Your assistant keeps answering meanwhile; this page updates by itself.",
      noteTone: "subdued",
      recheck: true,
    };
  }
  if (registered && input.runtime === "unverified") {
    return { connected: true, badge: { tone: "info", label: "Checking" }, note: null, noteTone: "caution", recheck: true };
  }
  const settling = input.provisionState === "provisioning" || input.runtime === "orphaned" || input.runtime === "pending";
  return { connected: false, badge: { tone: "attention", label: "Not connected" }, note: null, noteTone: "caution", recheck: settling };
}
