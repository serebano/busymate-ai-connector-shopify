import type { ActionFunctionArgs } from "react-router";
import { refreshStorefrontDomains } from "../bmai.server";
import { authenticateWebhookWithoutSession } from "../lib/webhookAuth";

// #3718 (Shopify review 5.1.2) — a custom domain connected, changed or removed
// after install. The chat frame's `frame-ancestors` must name every storefront
// domain a shopper can load, so a domain change re-reads the store's domains and
// repairs the tenant when its published allowlist lacks one (app/lib/tenantRepair.ts).
// HMAC only, no offline-session load (0.1.15): the library would first refresh an
// expired offline token and answer 500 when that fails, and Shopify deletes a
// subscription after 8 failed deliveries. Answered at once; the refresh runs in
// the background through `unauthenticated.admin(shop)` (which refreshes the token
// itself), gated per shop, and never throws.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateWebhookWithoutSession(request);
  console.log(`[domains] ${shop}: ${topic} → refreshing storefront domains`);
  void refreshStorefrontDomains(shop);
  return new Response();
};
