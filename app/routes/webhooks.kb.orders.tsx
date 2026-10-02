import type { ActionFunctionArgs } from "react-router";
import { scheduleReingest } from "../lib/ingest";
import { authenticateWebhookWithoutSession } from "../lib/webhookAuth";

// Order/fulfillment changes are NOT knowledge — a shopper's orders are read live
// through the store connection — so this hook never re-trains (the scheduler
// refuses the "orders" reason). Kept as the subscription target so the topic can
// be re-enabled once Protected Customer Data access is granted. HMAC only, no
// offline-session load (0.1.15), like every webhook route.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateWebhookWithoutSession(request);
  const r = scheduleReingest(shop, "orders");
  console.log(`[kb] ${topic} for ${shop} → ${r.scheduled ? "re-train queued" : `no re-train (${r.reason})`}`);
  return new Response();
};
