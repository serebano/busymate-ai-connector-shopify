import type { ActionFunctionArgs } from "react-router";
import { scheduleReingest } from "../lib/ingest";
import { authenticateWebhookWithoutSession } from "../lib/webhookAuth";

// KB freshness: on any product create/update/delete, re-train the tenant
// (products → knowledge_sources → publish) so grounded answers stay current.
// Debounced per shop (a bulk edit is one re-train); the outcome is persisted on
// ShopTenant (kbTrainedAt / kbError) and shown on Home + Store connection.
// HMAC only, no offline-session load (0.1.15): the re-train resolves and refreshes
// the token itself (unauthenticated.admin) after this delivery has been acked.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticateWebhookWithoutSession(request);
  const r = await scheduleReingest(shop, "products", webhookId);
  console.log(`[kb] ${topic} for ${shop} → re-train ${r.scheduled ? "queued" : `skipped: ${r.reason}`}`);
  return new Response();
};
