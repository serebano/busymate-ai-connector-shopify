export interface EmbeddedNavigation { shop: string; host: string }

/** Call only with the shop from authenticate.admin, never a query parameter. */
export function embeddedNavigationForShop(shop: string): EmbeddedNavigation {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error("Invalid authenticated shop");
  return { shop, host: btoa(`${shop}/admin`) };
}

/** Preserve routing context, never stale credentials, across internal app links. */
export function embeddedAppUrl(destination: string, context: EmbeddedNavigation | null): string {
  if (!context || !/^\/app(?:[/?#]|$)/.test(destination)) return destination;
  const url = new URL(destination, "https://embedded.invalid");
  for (const key of ["id_token", "hmac", "signature", "session", "shopify-reload"]) url.searchParams.delete(key);
  url.searchParams.set("shop", context.shop);
  url.searchParams.set("host", context.host);
  url.searchParams.set("embedded", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The embedded Home URL for a document that has no authenticated context (the
 * root error page): rebuilt from the frame's own `shop` + `host` query, both
 * shape-checked. A document load of it re-enters the session-token bounce, so no
 * stale credential is carried. Null when the query cannot name a shop: the page
 * then shows no link rather than one the embedded auth cannot serve.
 */
export function embeddedHomeFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const shop = params.get("shop") ?? "";
  const host = params.get("host") ?? "";
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(host)) return null;
  return embeddedAppUrl("/app", { shop, host });
}
