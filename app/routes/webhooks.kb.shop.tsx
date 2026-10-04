import type { ActionFunctionArgs } from "react-router";
import { scheduleReingest } from "../lib/ingest";
import { authenticateWebhookWithoutSession } from "../lib/webhookAuth";

// KB freshness (#52): shop/update — the store's name and settings are part of the
// knowledge snapshot (app/lib/kbFetch.ts), so a change re-trains, debounced per shop
// exactly like products/*. Shopify has NO webhook for shop policies or pages; those
// are bounded by the 72 h freshness backstop (scripts/kb-freshness.ts). HMAC only,
// no offline-session load (0.1.15 contract, test/webhookRoutes.test.ts).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateWebhookWithoutSession(request);
  const r = scheduleReingest(shop, "shop");
  console.log(`[kb] ${topic} for ${shop} → re-train ${r.scheduled ? "queued" : `skipped: ${r.reason}`}`);
  return new Response();
};
