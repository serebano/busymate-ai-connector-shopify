import { useEffect } from "react";
import { useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Shopify's own loading bar (App Bridge Loading API) while a page of the app is
 * being fetched. Every nav item, back action and in-page link is a client-side
 * navigation whose loader runs on the server; without this the admin shows the
 * previous page with no sign that the click registered. One effect, no markup.
 */
export function AdminLoadingBar() {
  const shopify = useAppBridge();
  const busy = useNavigation().state !== "idle";
  useEffect(() => {
    shopify.loading(busy);
    return () => {
      if (busy) shopify.loading(false);
    };
  }, [busy, shopify]);
  return null;
}
