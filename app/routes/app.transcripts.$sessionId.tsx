import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { AppRouteBoundary } from "../components/AppRouteError";
import { embeddedAppUrl, embeddedNavigationForShop } from "../lib/embeddedNavigation";

export const ErrorBoundary = AppRouteBoundary;

// Moved under Conversations (/app/conversations/transcripts/…) so the admin highlights the
// parent nav item. Links and bookmarks to the old address keep working.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { redirect, session } = await authenticate.admin(request);
  // Routing context only (shop, host, embedded): never a stale id_token from the old link.
  throw redirect(embeddedAppUrl(`/app/conversations/transcripts/${encodeURIComponent(params.sessionId ?? "")}`, embeddedNavigationForShop(session.shop)));
};

export default function MovedPage() {
  return null;
}
