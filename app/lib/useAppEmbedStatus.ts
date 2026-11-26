import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { embedFromExtensions, type EmbedStatus } from "./themeEmbed";

/**
 * G2 / BFS 4.2.3 — the app embed's state on the published theme, from App Bridge
 * `shopify.app.extensions()` (no access scope, no server round-trip; works on a
 * password-protected store). "checking" until App Bridge answers; re-checked
 * whenever the merchant comes back to the tab (e.g. after saving in the theme
 * editor), so Home never needs a reload or a manual confirmation.
 */
export function useAppEmbedStatus(): EmbedStatus {
  const shopify = useAppBridge();
  const [status, setStatus] = useState<EmbedStatus>("checking");
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
