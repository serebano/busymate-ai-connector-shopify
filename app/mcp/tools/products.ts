import type { ToolContext, ToolResult } from "./types";
import { textResult } from "./types";
import { formatMoney, loadMoneyFormat, type ShopMoneyFormat } from "../../lib/money";
import { ONLINE_STORE_QUERY, onOnlineStore, storefrontProductUrl } from "../../lib/onlineStore";

/**
 * Public catalog reads — Admin GraphQL (2026-07) with the shop offline token. No
 * store PII, so these are the `public` tier (anonymous callers). Each maps the raw
 * GraphQL nodes to a concise, grounded shape Busymate AI can cite verbatim.
 */

interface Money {
  amount: string;
  currencyCode: string;
}

/** Money with the shop format (see lib/money). */
function money(m?: Money | null, fmt?: ShopMoneyFormat | null): string | null {
  if (!m) return null;
  return formatMoney(m, fmt);
}

/** Collapse HTML/whitespace to a short plain-text blurb (grounded, no markup). */
function plain(html: string | null | undefined, max = 280): string {
  const text = String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status: string;
  featuredImage?: { url: string } | null;
  onlineStoreUrl?: string | null;
  publishedAt?: string | null;
  totalInventory?: number | null;
  isGiftCard?: boolean | null;
  priceRangeV2?: { minVariantPrice?: Money; maxVariantPrice?: Money } | null;
  compareAtPriceRange?: { minVariantCompareAtPrice?: Money | null; maxVariantCompareAtPrice?: Money | null } | null;
}

/**
 * src#2624 reviewer F13 — "Which snowboards are on sale?" was answered "none" although
 * products had a compare-at price: the tools never fetched it. A product is ON SALE when
 * its compare-at price is above its price.
 */
export function saleOf(price?: Money | null, compareAt?: Money | null, fmt?: ShopMoneyFormat | null): string | null {
  if (!price || !compareAt) return null;
  const p = Number(price.amount);
  const c = Number(compareAt.amount);
  return Number.isFinite(p) && Number.isFinite(c) && c > p ? money(compareAt, fmt) : null;
}

export interface ProductSummary {
  title: string;
  handle: string;
  url: string | null;
  price: string | null;
  /** src#2679 — the lowest variant price as a NUMBER (null when unknown), so ordering is never left to string reading. */
  priceAmount: number | null;
  currency: string | null;
  /** The compare-at ("was") price when the product is on sale, else null. */
  compareAtPrice: string | null;
  onSale: boolean;
  available: boolean;
  /** A gift card is listed as one (it often matches a keyword through its vendor), never counted as the thing asked for. */
  giftCard: boolean;
  image: string | null;
}

function amountOf(m?: Money | null): number | null {
  if (!m) return null;
  const n = Number(m.amount);
  return Number.isFinite(n) ? n : null;
}

/**
 * src#2679 — "¿Cuál es la snowboard más barata?" was answered with a product that was
 * NOT the cheapest, then contradicted: the tool returned Shopify's relevance order (top
 * 10 only) and left the model to compare "629.95 USD" against "600.00 USD" in prose. A
 * price question is answered in code: `sort: "price_asc" | "price_desc"` reads the whole
 * matching catalog (up to 250), orders it NUMERICALLY, and the reply names the cheapest
 * and the most expensive explicitly. Unknown prices sort last; ties keep title order.
 */
export type ProductSort = "relevance" | "price_asc" | "price_desc";
export const PRODUCT_SORTS: readonly ProductSort[] = ["relevance", "price_asc", "price_desc"];

export function sortByPrice(products: readonly ProductSummary[], dir: "asc" | "desc"): ProductSummary[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...products].sort((a, b) => {
    if (a.priceAmount === null || b.priceAmount === null) {
      if (a.priceAmount === b.priceAmount) return a.title.localeCompare(b.title);
      return a.priceAmount === null ? 1 : -1;
    }
    return sign * (a.priceAmount - b.priceAmount) || a.title.localeCompare(b.title);
  });
}

/** The lowest- and highest-priced products of a list (unknown prices ignored), or null. */
export function priceExtremes(products: readonly ProductSummary[]): { cheapest: ProductSummary; mostExpensive: ProductSummary } | null {
  const priced = sortByPrice(products.filter((p) => p.priceAmount !== null), "asc");
  if (priced.length === 0) return null;
  return { cheapest: priced[0]!, mostExpensive: priced[priced.length - 1]! };
}

function summarizeProduct(n: ProductNode, shop: string, fmt?: ShopMoneyFormat | null): ProductSummary {
  return {
    title: n.title,
    handle: n.handle,
    url: storefrontProductUrl(shop, n),
    price: money(n.priceRangeV2?.minVariantPrice, fmt),
    priceAmount: amountOf(n.priceRangeV2?.minVariantPrice),
    currency: n.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
    compareAtPrice: saleOf(n.priceRangeV2?.minVariantPrice, n.compareAtPriceRange?.minVariantCompareAtPrice, fmt),
    onSale: saleOf(n.priceRangeV2?.minVariantPrice, n.compareAtPriceRange?.minVariantCompareAtPrice) !== null,
    available: (n.totalInventory ?? 0) > 0 && n.status === "ACTIVE",
    giftCard: n.isGiftCard === true,
    image: n.featuredImage?.url ?? null,
  };
}

/**
 * src 2026-11-26 (v12-review-1126, guest storefront chat) — "Which snowboards do you sell under 700 dollars?" was
 * answered "We have four snowboards under $700" and then "That's three, not four." The tool returned the whole
 * catalog and left the model to filter prices in prose; it counted the out-of-stock Gift Card (it matches
 * "snowboard" through its vendor) before it listed. A price condition is applied in code, like the sort: the
 * whole matching catalog is read, filtered NUMERICALLY, and the reply states the exact count it holds.
 *   - min_price: at least (inclusive)           "from $500", "$500 or more"
 *   - max_price: at most (inclusive)            "up to $700", "$700 or less"
 *   - under_price: strictly below (exclusive)   "under $700", "less than $700", "cheaper than $700"
 * Amounts are in the shop currency. A product's price is its lowest variant price (what the listing shows "from").
 */
export interface PriceBounds {
  min: number | null;
  max: number | null;
  under: number | null;
}

function bound(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function priceBoundsOf(args: Record<string, unknown>): PriceBounds {
  return { min: bound(args.min_price), max: bound(args.max_price), under: bound(args.under_price) };
}

export function hasPriceBounds(b: PriceBounds): boolean {
  return b.min !== null || b.max !== null || b.under !== null;
}

/** Within the bounds; a product with no known price never matches a price condition. */
export function withinPrice(p: Pick<ProductSummary, "priceAmount">, b: PriceBounds): boolean {
  if (!hasPriceBounds(b)) return true;
  if (p.priceAmount === null) return false;
  if (b.min !== null && p.priceAmount < b.min) return false;
  if (b.max !== null && p.priceAmount > b.max) return false;
  if (b.under !== null && p.priceAmount >= b.under) return false;
  return true;
}

/** The bounds in words, in the shop's money format ("priced under $700.00", "priced $500.00–$800.00"). */
function boundsPhrase(b: PriceBounds, currency: string | null, fmt?: ShopMoneyFormat | null): string {
  const f = (n: number) => formatMoney({ amount: n.toFixed(2), currencyCode: currency ?? fmt?.currencyCode ?? "USD" }, fmt) ?? String(n);
  const parts: string[] = [];
  if (b.min !== null) parts.push(`at least ${f(b.min)}`);
  if (b.max !== null) parts.push(`at most ${f(b.max)}`);
  if (b.under !== null) parts.push(`under ${f(b.under)}`);
  return parts.length ? ` priced ${parts.join(" and ")}` : "";
}

export async function searchProducts(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const onSaleOnly = args.on_sale === true;
  const sort: ProductSort = PRODUCT_SORTS.includes(args.sort as ProductSort) ? (args.sort as ProductSort) : "relevance";
  const byPrice = sort !== "relevance";
  const bounds = priceBoundsOf(args);
  const priced = hasPriceBounds(bounds);
  // "sale" is not a catalog keyword: an on-sale question lists the products whose
  // compare-at price is above their price (fetches a wider page, then filters).
  const query = onSaleOnly ? String(args.query ?? "").replace(/\b(on\s+)?sale\b|\bdiscount(ed)?\b/gi, "").trim() : String(args.query ?? "").trim();
  const limit = Math.max(1, Math.min(Number(args.first ?? 10) || 10, 25));
  // A price-ordered or price-filtered answer must see every match, not Shopify's first
  // relevance page (the Admin API has no PRICE sort key or price filter for products).
  const first = byPrice || priced ? 250 : onSaleOnly ? 100 : limit;
  const data = (await ctx.admin.graphql(
    `#graphql
    query SearchProducts($q: String!, $n: Int!) {
      products(query: $q, first: $n) {
        nodes {
          id title handle status onlineStoreUrl publishedAt totalInventory isGiftCard
          featuredImage { url }
          priceRangeV2 { minVariantPrice { amount currencyCode } }
          compareAtPriceRange { minVariantCompareAtPrice { amount currencyCode } }
        }
      }
    }`,
    // src#2624 X2 — only products published to the Online Store: the search filter
    // asks Shopify for them, and `onOnlineStore` re-checks every node in code.
    { q: `${ONLINE_STORE_QUERY} ${query}`.trim(), n: first },
  )) as { products?: { nodes?: ProductNode[] } };

  const fmt = await loadMoneyFormat(ctx.admin);
  const all = (data.products?.nodes ?? []).filter(onOnlineStore).map((n) => summarizeProduct(n, ctx.shop, fmt));
  const matching = all.filter((p) => (!onSaleOnly || p.onSale) && withinPrice(p, bounds));
  // Extremes over EVERY match fetched, before the page is cut to `first`.
  const extremes = priceExtremes(matching);
  const ordered = byPrice ? sortByPrice(matching, sort === "price_asc" ? "asc" : "desc") : matching;
  const products = byPrice || priced ? ordered.slice(0, limit) : ordered;
  const within = boundsPhrase(bounds, all.find((p) => p.currency)?.currency ?? null, fmt);
  const priceFilter = priced ? { minPrice: bounds.min, maxPrice: bounds.max, underPrice: bounds.under } : null;
  if (products.length === 0) {
    return textResult(
      onSaleOnly
        ? `No products are on sale right now${query ? ` matching “${query}”` : ""}${within}.`
        : `No products match “${query}”${within}.`,
      { query, onSale: onSaleOnly, sort, priceFilter, total: 0, products: [] },
    );
  }
  const lines = products.map(
    (p) => `• ${p.title}${p.giftCard ? " (gift card)" : ""}${p.price ? ` — ${p.price}` : ""}${p.compareAtPrice ? ` (on sale, was ${p.compareAtPrice})` : ""}${p.available ? "" : " (out of stock)"}`,
  );
  const total = matching.length;
  const order = byPrice ? `, sorted by price (${sort === "price_asc" ? "lowest" : "highest"} first)` : "";
  const shown = products.length < total ? ` (showing ${products.length} of ${total})` : "";
  const head = onSaleOnly
    ? `${total} product${total === 1 ? "" : "s"} on sale${query ? ` matching “${query}”` : ""}${within}${order}${shown}:`
    : `${total} product${total === 1 ? "" : "s"} matching “${query}”${within}${order}${shown}:`;
  // A gift card matched by keyword is not the thing asked for: say how many of the count are gift cards.
  const giftCards = matching.filter((p) => p.giftCard).length;
  const giftNote = giftCards > 0 && query ? `\n${giftCards} of these ${total} ${giftCards === 1 ? "is a gift card" : "are gift cards"}, not “${query}”.` : "";
  // The cheapest / most expensive are stated in code, so the reply never has to rank prices itself.
  const scope = byPrice || onSaleOnly || priced ? "of all matches" : `of these ${products.length}`;
  const foot = extremes && total > 1
    ? `\nLowest price ${scope}: ${extremes.cheapest.title} — ${extremes.cheapest.price}. Highest: ${extremes.mostExpensive.title} — ${extremes.mostExpensive.price}.`
    : "";
  return textResult(`${head}\n${lines.join("\n")}${giftNote}${foot}`, {
    query,
    onSale: onSaleOnly,
    sort,
    priceFilter,
    total,
    giftCards,
    cheapest: extremes?.cheapest ?? null,
    mostExpensive: extremes?.mostExpensive ?? null,
    products,
  });
}

interface VariantNode {
  id: string;
  title: string;
  price: string;
  compareAtPrice?: string | null;
  availableForSale: boolean;
  inventoryQuantity?: number | null;
  sku?: string | null;
}

/** A variant price is a bare amount in the shop currency; format it like the rest. */
function variantMoney(amount: string, currencyCode: string | null | undefined, fmt: ShopMoneyFormat | null): string {
  return formatMoney({ amount, currencyCode: currencyCode ?? fmt?.currencyCode ?? null }, fmt) ?? amount;
}

export async function getProduct(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const handle = String(args.handle ?? "").trim();
  const data = (await ctx.admin.graphql(
    `#graphql
    query GetProduct($handle: String!) {
      productByHandle(handle: $handle) {
        id title descriptionHtml status handle onlineStoreUrl publishedAt
        priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
        variants(first: 50) { nodes { id title price compareAtPrice availableForSale inventoryQuantity sku } }
      }
    }`,
    { handle },
  )) as {
    productByHandle?: {
      id: string;
      title: string;
      descriptionHtml?: string | null;
      status: string;
      handle: string;
      onlineStoreUrl?: string | null;
      publishedAt?: string | null;
      priceRangeV2?: { minVariantPrice?: Money; maxVariantPrice?: Money } | null;
      variants?: { nodes?: VariantNode[] };
    } | null;
  };

  const p = data.productByHandle;
  // src#2624 X2 — a product that is not on the Online Store is answered exactly like a
  // missing one: the shopper cannot open or buy it, and its details stay the merchant's.
  if (!p || !onOnlineStore(p)) return textResult(`No product found for “${handle}”.`, { handle, product: null });

  const fmt = await loadMoneyFormat(ctx.admin);
  const variants = (p.variants?.nodes ?? []).map((v) => ({
    title: v.title,
    price: variantMoney(v.price, p.priceRangeV2?.minVariantPrice?.currencyCode, fmt),
    compareAtPrice: v.compareAtPrice && Number(v.compareAtPrice) > Number(v.price) ? variantMoney(v.compareAtPrice, p.priceRangeV2?.minVariantPrice?.currencyCode, fmt) : null,
    available: v.availableForSale,
    quantity: v.inventoryQuantity ?? null,
    sku: v.sku ?? null,
  }));
  const product = {
    title: p.title,
    handle: p.handle,
    url: storefrontProductUrl(ctx.shop, p),
    description: plain(p.descriptionHtml),
    priceFrom: money(p.priceRangeV2?.minVariantPrice, fmt),
    onSale: variants.some((v) => v.compareAtPrice),
    available: variants.some((v) => v.available),
    variants,
  };
  const sale = variants.find((v) => v.compareAtPrice);
  return textResult(
    `${product.title}${product.priceFrom ? ` — from ${product.priceFrom}` : ""}${sale ? ` (on sale: ${sale.price}, was ${sale.compareAtPrice})` : ""}. ${product.description}`,
    { product },
  );
}

export async function listCollections(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const first = Math.max(1, Math.min(Number(args.first ?? 25) || 25, 50));
  const data = (await ctx.admin.graphql(
    `#graphql
    query Collections($n: Int!) {
      collections(first: $n, sortKey: TITLE) {
        nodes { id title handle productsCount { count } }
      }
    }`,
    { n: first },
  )) as {
    collections?: { nodes?: Array<{ title: string; handle: string; productsCount?: { count?: number } | null }> };
  };

  const collections = (data.collections?.nodes ?? []).map((c) => ({
    title: c.title,
    handle: c.handle,
    productCount: c.productsCount?.count ?? null,
  }));
  const lines = collections.map((c) => `• ${c.title}${c.productCount != null ? ` (${c.productCount})` : ""}`);
  return textResult(
    collections.length ? `${collections.length} collections:\n${lines.join("\n")}` : "No collections.",
    { collections },
  );
}
