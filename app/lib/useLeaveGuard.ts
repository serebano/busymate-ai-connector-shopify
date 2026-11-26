import { useEffect } from "react";
import { useBlocker } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Keeps unsaved edits from being lost by a navigation INSIDE the app frame
 * (browser Back/Forward, an in-page link). Shopify's admin already holds its own
 * links while the contextual save bar shows; this covers the app's router with
 * the documented `shopify.saveBar.leaveConfirmation()` prompt
 * (shopify.dev/docs/api/app-bridge-library/apis/save-bar): the merchant chooses,
 * and only a confirmed leave hides the bar and continues.
 */
export function useLeaveGuard(dirty: boolean, saveBarId: string): void {
  const shopify = useAppBridge();
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let current = true;
    void (async () => {
      try {
        await shopify.saveBar.leaveConfirmation();
        await shopify.saveBar.hide(saveBarId);
        if (current) blocker.proceed();
      } catch {
        if (current) blocker.reset();
      }
    })();
    return () => {
      current = false;
    };
  }, [blocker, saveBarId, shopify]);
}
