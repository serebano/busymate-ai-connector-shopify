import type { ToolContext, ToolResult } from "./types";
import { textResult } from "./types";

/**
 * Public catalog reads — Admin GraphQL (2026-07) with the shop offline token. No
 * store PII, so these are the `public` tier (anonymous callers). Each maps the raw
 * GraphQL nodes to a concise, grounded shape Busymate AI can cite verbatim.
 */

interface Money {
  amount: string;
  currencyCode: string;
}

function money(m?: Money | null): string | null {
  if (!m) return null;
  return `${m.amount} ${m.currencyCode}`;
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
  totalInventory?: number | null;
  priceRangeV2?: { minVariantPrice?: Money; maxVariantPrice?: Money } | null;
  compareAtPriceRange?: { minVariantCompareAtPrice?: Money | null; maxVariantCompareAtPrice?: Money | null } | null;
}

/**
 * src#2624 reviewer F13 — "Which snowboards are on sale?" was answered "none" although
 * products had a compare-at price: the tools never fetched it. A product is ON SALE when
 * its compare-at price is above its price.
 */
export function saleOf(price?: Money | null, compareAt?: Money | null): string | null {
  if (!price || !compareAt) return null;
  const p = Number(price.amount);
  const c = Number(compareAt.amount);
  return Number.isFinite(p) && Number.isFinite(c) && c > p ? money(compareAt) : null;
}

export interface ProductSummary {
  title: string;
  handle: string;
  url: string | null;
  price: string | null;
  /** The compare-at ("was") price when the product is on sale, else null. */
  compareAtPrice: string | null;
  onSale: boolean;
  available: boolean;
  image: string | null;
}

function summarizeProduct(n: ProductNode): ProductSummary {
  return {
    title: n.title,
    handle: n.handle,
    url: n.onlineStoreUrl ?? null,
    price: money(n.priceRangeV2?.minVariantPrice),
    compareAtPrice: saleOf(n.priceRangeV2?.minVariantPrice, n.compareAtPriceRange?.minVariantCompareAtPrice),
    onSale: saleOf(n.priceRangeV2?.minVariantPrice, n.compareAtPriceRange?.minVariantCompareAtPrice) !== null,
    available: (n.totalInventory ?? 0) > 0 && n.status === "ACTIVE",
    image: n.featuredImage?.url ?? null,
  };
}

export async function searchProducts(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const onSaleOnly = args.on_sale === true;
  // "sale" is not a catalog keyword: an on-sale question lists the products whose
  // compare-at price is above their price (fetches a wider page, then filters).
  const query = onSaleOnly ? String(args.query ?? "").replace(/\b(on\s+)?sale\b|\bdiscount(ed)?\b/gi, "").trim() : String(args.query ?? "").trim();
  const first = onSaleOnly ? 100 : Math.max(1, Math.min(Number(args.first ?? 10) || 10, 25));
  const data = (await ctx.admin.graphql(
    `#graphql
    query SearchProducts($q: String!, $n: Int!) {
      products(query: $q, first: $n) {
        nodes {
          id title handle status onlineStoreUrl totalInventory
          featuredImage { url }
          priceRangeV2 { minVariantPrice { amount currencyCode } }
          compareAtPriceRange { minVariantCompareAtPrice { amount currencyCode } }
        }
      }
    }`,
    { q: `status:active ${query}`.trim(), n: first },
  )) as { products?: { nodes?: ProductNode[] } };

  const all = (data.products?.nodes ?? []).map(summarizeProduct);
  const products = onSaleOnly ? all.filter((p) => p.onSale) : all;
  if (products.length === 0) {
    return textResult(onSaleOnly ? `No products are on sale right now${query ? ` matching “${query}”` : ""}.` : `No products match “${query}”.`, { query, onSale: onSaleOnly, products: [] });
  }
  const lines = products.map(
    (p) => `• ${p.title}${p.price ? ` — ${p.price}` : ""}${p.compareAtPrice ? ` (on sale, was ${p.compareAtPrice})` : ""}${p.available ? "" : " (out of stock)"}`,
  );
  const head = onSaleOnly
    ? `${products.length} product${products.length === 1 ? "" : "s"} on sale${query ? ` matching “${query}”` : ""}:`
    : `${products.length} product${products.length === 1 ? "" : "s"} matching “${query}”:`;
  return textResult(`${head}\n${lines.join("\n")}`, { query, onSale: onSaleOnly, products });
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

export async function getProduct(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const handle = String(args.handle ?? "").trim();
  const data = (await ctx.admin.graphql(
    `#graphql
    query GetProduct($handle: String!) {
      productByHandle(handle: $handle) {
        id title descriptionHtml status handle onlineStoreUrl
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
      priceRangeV2?: { minVariantPrice?: Money; maxVariantPrice?: Money } | null;
      variants?: { nodes?: VariantNode[] };
    } | null;
  };

  const p = data.productByHandle;
  if (!p) return textResult(`No product found for “${handle}”.`, { handle, product: null });

  const variants = (p.variants?.nodes ?? []).map((v) => ({
    title: v.title,
    price: v.price,
    compareAtPrice: v.compareAtPrice && Number(v.compareAtPrice) > Number(v.price) ? v.compareAtPrice : null,
    available: v.availableForSale,
    quantity: v.inventoryQuantity ?? null,
    sku: v.sku ?? null,
  }));
  const product = {
    title: p.title,
    handle: p.handle,
    url: p.onlineStoreUrl ?? null,
    description: plain(p.descriptionHtml),
    priceFrom: money(p.priceRangeV2?.minVariantPrice),
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
