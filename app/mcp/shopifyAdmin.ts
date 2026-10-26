export interface ShopifyAdminClient {
  shop: string;
  /** `apiVersion` pins ONE call to a newer Admin API version than the app's default. */
  graphql(query: string, variables?: Record<string, unknown>, opts?: { apiVersion?: string }): Promise<unknown>;
}

/**
 * Resolve the shop's OFFLINE session through the library — which loads it via the
 * encrypting session storage and, under expiring offline tokens (#2110), REFRESHES
 * it when it is within 5 minutes of expiry and stores the new one. Every
 * background Admin call (MCP connector tools, KB ingest, billing reconcile, usage
 * metering) therefore never presents a stale token.
 *
 * The Shopify app module is imported lazily: importing this client (from
 * ingest/billing/tool modules) must not boot `shopifyApp()` — which validates the
 * env and polls the Session table — at module load, so those modules stay
 * unit-testable without a configured app.
 */
async function resolveAdmin(shop: string) {
  const { unauthenticated } = await import("../shopify.server");
  try {
    return await unauthenticated.admin(shop);
  } catch (err) {
    if (err instanceof Error && err.name === "SessionNotFoundError") {
      throw new Error(`no offline token for ${shop} — reinstall required`);
    }
    throw err;
  }
}

/**
 * An Admin GraphQL client bound to ONE shop's offline session. Fails eagerly when
 * the shop has no session (the MCP transport turns that into a clean tool error),
 * and re-resolves the session on EVERY call so a refreshed token is always used —
 * the client object may outlive a token's 1-hour lifetime.
 */
export async function adminForShop(shop: string): Promise<ShopifyAdminClient> {
  await resolveAdmin(shop);
  return {
    shop,
    async graphql(query, variables, opts) {
      const { admin } = await resolveAdmin(shop);
      const res = await admin.graphql(query, {
        variables: variables ?? {},
        ...(opts?.apiVersion ? { apiVersion: opts.apiVersion as never } : {}),
      });
      if (!res.ok) throw new Error(`Shopify Admin ${res.status}`);
      const json = (await res.json()) as { data?: unknown; errors?: unknown };
      if (json.errors) throw new Error(`Shopify Admin GraphQL errors: ${JSON.stringify(json.errors)}`);
      return json.data;
    },
  };
}
