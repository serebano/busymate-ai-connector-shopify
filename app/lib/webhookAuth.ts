import crypto from "node:crypto";

/**
 * Session-free webhook authentication (busymate-devtools#3731).
 *
 * `authenticate.webhook` from `@shopify/shopify-app-react-router` verifies the
 * HMAC and THEN loads the shop's offline session; with
 * `future.expiringOfflineAccessTokens` on, a stored token that has expired (or is
 * within 5 min of expiry) is refreshed first. On `app/uninstalled` and the GDPR
 * compliance topics the app is already uninstalled, so that refresh fails and the
 * delivery answers 500. Shopify retries, gives up, and the uninstall teardown and
 * the `shop/redact` purge never run (the Dev Dashboard showed a 51.4 % webhook
 * failure rate).
 *
 * No webhook handler needs the session at delivery time: each only needs the
 * verified shop, topic and payload, and the Admin-API work some of them trigger
 * (the domains refresh, a re-train) runs in the background through
 * `unauthenticated.admin(shop)` with its own error handling. This helper checks
 * exactly what the library checks first (POST, the HMAC over the raw body, the
 * required headers) and never touches a session. Since 0.1.15 EVERY webhook
 * route uses it (a delivery must be acked 2xx fast — Shopify retries a failing
 * subscription and DELETES it after 8 failures); `test/webhookAuth.test.ts`
 * derives the route list from `app/routes/webhooks.*.tsx` and refuses any
 * `authenticate.webhook` there.
 */

/**
 * The library's offline session id for a shop (`api.session.getOfflineId`):
 * `offline_<shop>`. Lets a webhook update the stored offline session row (e.g.
 * its scope set) WITHOUT loading it through the refreshing path.
 */
export function offlineSessionId(shop: string): string {
  return `offline_${shop}`;
}

export type SessionFreeWebhook = {
  shop: string;
  /** Normalised like the library's `topicForStorage`: `app/uninstalled` → `APP_UNINSTALLED`. */
  topic: string;
  payload: Record<string, unknown> | null;
  webhookId: string;
  apiVersion: string;
};

export function webhookTopicKey(topic: string): string {
  return topic.toUpperCase().replace(/\/|\./g, "_");
}

/** base64 HMAC-SHA256 of the raw body with the app secret, compared in constant time. Fails closed. */
export function verifyWebhookHmac(rawBody: string, hmacHeader: string | null, secret: string): boolean {
  if (!secret || !hmacHeader) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"));
  const given = Buffer.from(hmacHeader);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Throws a `Response` exactly where `authenticate.webhook` would: 405 for a
 * non-POST, 401 for a bad or missing HMAC, 400 for missing headers or a body
 * that is not JSON.
 */
export async function authenticateWebhookWithoutSession(
  request: Request,
  secret: string = process.env.SHOPIFY_API_SECRET || "",
): Promise<SessionFreeWebhook> {
  if (request.method !== "POST") throw new Response(undefined, { status: 405, statusText: "Method not allowed" });
  const rawBody = await request.text();
  if (!verifyWebhookHmac(rawBody, request.headers.get("x-shopify-hmac-sha256"), secret)) {
    throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
  }
  const shop = (request.headers.get("x-shopify-shop-domain") ?? "").trim().toLowerCase();
  const topic = request.headers.get("x-shopify-topic") ?? "";
  const webhookId = request.headers.get("x-shopify-webhook-id") ?? "";
  const apiVersion = request.headers.get("x-shopify-api-version") ?? "";
  if (!SHOP_DOMAIN.test(shop) || !topic || !webhookId || !apiVersion) {
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }
  let payload: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new Response(undefined, { status: 400, statusText: "Bad Request" });
    }
  }
  return { shop, topic: webhookTopicKey(topic), payload, webhookId, apiVersion };
}
