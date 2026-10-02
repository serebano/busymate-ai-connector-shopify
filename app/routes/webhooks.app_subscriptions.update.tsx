import type { ActionFunctionArgs } from "react-router";
import { subscriptionStateFromWebhook } from "../lib/billingSync";
import { syncBillingState } from "../lib/billingState.server";
import { authenticateWebhookWithoutSession } from "../lib/webhookAuth";

/**
 * `app_subscriptions/update` — Shopify fires this when a merchant accepts, declines,
 * cancels, freezes, or re-requests the app subscription. We normalize the status and
 * upsert BillingState so `resolveBillingAccess()` reflects the real plan on the next
 * admin load (Req 1.2.2). HMAC is verified without loading the offline session
 * (0.1.15): the sync is a DB write and needs no Admin API, and the library's
 * session-refreshing path answers 500 once the shop's token can no longer be
 * refreshed (a cancel after an uninstall), which would cost the subscription.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticateWebhookWithoutSession(request);
  const state = subscriptionStateFromWebhook(payload);
  const synced = await syncBillingState(shop, state);
  console.log(`[billing] ${topic} shop=${shop} status=${state.status} synced=${synced}`);
  return new Response();
};
