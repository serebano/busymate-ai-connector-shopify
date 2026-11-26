import { useEffect } from "react";
import { useNavigate } from "react-router";

/**
 * The ONE piece of `@shopify/shopify-app-react-router/react`'s `AppProvider` this
 * app needs: admin nav clicks (`<ui-nav-menu>`) dispatch `shopify:navigate` on the
 * anchor, and we route them client-side.
 *
 * Why not `AppProvider` (red-team F5, 2026-11-26): it renders TWO parser-blocking
 * scripts in <body> before the page — a second `app-bridge.js` (root.tsx already
 * loads it first in <head>, as Built for Shopify requires) and `polaris.js`, the
 * Polaris web-components bundle (149 KB br / 740 KB raw) that this app never
 * uses (it renders Polaris React). Enforced by test/appBridgeOnce.test.ts.
 */
export function AppBridgeNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const href = (event.target as Element | null)?.getAttribute?.("href");
      if (href) navigate(href);
    };
    document.addEventListener("shopify:navigate", onNavigate);
    return () => document.removeEventListener("shopify:navigate", onNavigate);
  }, [navigate]);
  return null;
}
