import type { ActionFunctionArgs } from "react-router";
import { onAppUninstalled } from "../shopify.server";
import { cancelReingest } from "../lib/ingest";
import { authenticateWebhookWithoutSession } from "../lib/webhookAuth";

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC only, no offline-session load: the library would first refresh an expired
  // offline token, which fails once the app is uninstalled and answered 500 (#3731).
  const { shop, topic } = await authenticateWebhookWithoutSession(request);
  console.log(`Received ${topic} for ${shop}`);
  // Stop retraining (#52): drop any queued webhook re-train for this shop.
  if (cancelReingest(shop)) console.log(`[kb] ${shop}: pending re-train cancelled (uninstalled)`);
  // Suspend/teardown the tenant + purge sessions (do NOT hard-delete on uninstall;
  // shop/redact 48h later does the full purge).
  await onAppUninstalled(shop);
  return new Response();
};
