/**
 * ONE answer to "may a shopper be told about this product?" (src#2624 independent
 * review X2, 2026-10-24).
 *
 * RED ANCHOR: "The Hidden Snowboard" (in every Shopify generated test store) is
 * ACTIVE but published to no sales channel. The assistant listed it among the
 * cheapest boards and linked `/products/the-hidden-snowboard`, which is a 404.
 * The KB treated `status: ACTIVE` as "published" and the catalog tools searched
 * `status:active` only, so an unpublished product reached the shopper.
 *
 * A product is shown to a shopper only when it is published to the ONLINE STORE
 * sales channel: `onlineStoreUrl` is set, or `publishedAt` (the Online Store
 * publication date) is set. `onlineStoreUrl` alone is not enough: it is null on
 * every product of a password-protected store (all dev stores), while
 * `publishedAt` still tells the published ones apart (measured live on
 * bmai-independent-review-3: 13 of 15 active products have `publishedAt`, the
 * Hidden and Minimal snowboards do not). DRAFT and ARCHIVED never qualify.
 *
 * Pure: shared by the catalog tools (app/mcp/tools/products.ts) and the trained
 * knowledge (app/lib/kbSnapshot.ts), so the two can never disagree.
 */
export interface OnlineStoreFields {
  status?: string | null;
  onlineStoreUrl?: string | null;
  publishedAt?: string | null;
  handle?: string | null;
}

/** The Admin GraphQL search filter that keeps a product query to the Online Store. */
export const ONLINE_STORE_QUERY = "status:active published_status:published";

export function onOnlineStore(p: OnlineStoreFields): boolean {
  const status = (p.status ?? "").toUpperCase();
  if (status === "DRAFT" || status === "ARCHIVED") return false;
  return Boolean(p.onlineStoreUrl) || Boolean(p.publishedAt);
}

/** The product's storefront address, or null when it is not on the Online Store. */
export function storefrontProductUrl(shop: string, p: OnlineStoreFields): string | null {
  if (!onOnlineStore(p)) return null;
  if (p.onlineStoreUrl) return p.onlineStoreUrl;
  return p.handle && shop ? `https://${shop}/products/${p.handle}` : null;
}
