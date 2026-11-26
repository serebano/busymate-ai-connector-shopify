import { useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { embedFromExtensions, type EmbedStatus } from "./themeEmbed";

/**
 * G2 / BFS 4.2.3 — the app embed's state on the published theme, from App Bridge
 * `shopify.app.extensions()` (no access scope, no server round-trip; works on a
 * password-protected store). "checking" until App Bridge answers; re-checked
 * whenever the merchant comes back to the tab (e.g. after saving in the theme
 * editor), so Home never needs a reload or a manual confirmation.
 *
 * `initial` is the LAST KNOWN answer the server rendered (F5, admin CLS): the
 * first paint already shows the card and checklist in their final shape, so the
 * App Bridge answer (usually the same) moves nothing. A changed answer is
 * reported back once (`reportEmbedStatus`) so the next render starts right.
 */
export function useAppEmbedStatus(initial: EmbedStatus = "checking"): EmbedStatus {
  const shopify = useAppBridge();
  const [status, setStatus] = useState<EmbedStatus>(initial);
  useEffect(() => {
    let alive = true;
    const check = () => {
      Promise.resolve()
        .then(() => shopify.app.extensions())
        .then(
          (extensions) => {
            if (alive) setStatus(embedFromExtensions(extensions) ?? "unknown");
          },
          () => {
            // Keep a known answer on a transient failure; only a first failure reads as unknown.
            if (alive) setStatus((prev) => (prev === "checking" ? "unknown" : prev));
          },
        );
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [shopify]);
  return status;
}

/**
 * Persist a definite App Bridge answer that differs from the server's last known
 * one (`POST /api/embed-status`, session token added by App Bridge's fetch).
 * Fire-and-forget: a failed report only means the next load starts from the old
 * value and corrects itself again.
 */
export function useReportEmbedStatus(status: EmbedStatus, lastKnown: EmbedStatus) {
  const stored = useRef(lastKnown);
  useEffect(() => {
    if (!shouldReportEmbed(status, stored.current)) return;
    stored.current = status;
    fetch("/api/embed-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => undefined);
  }, [status]);
}

/** Report only a definite answer that differs from what the server has stored. */
export function shouldReportEmbed(status: EmbedStatus, stored: EmbedStatus): boolean {
  return (status === "on" || status === "off") && status !== stored;
}
