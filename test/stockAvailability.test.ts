import { describe, expect, it } from "vitest";
import { productAvailable, searchProducts, getProduct, VARIANT_PROBE } from "../app/mcp/tools/products";

/**
 * Review2 D1 (2026-11-26) — stock answers follow Shopify's `availableForSale`, never the
 * inventory count. Shapes below are the live Admin answers of a Shopify "test data" store
 * (probed 2026-11-26 on review2-sim-1126).
 */
const m = (amount: string) => ({ amount, currencyCode: "USD" });
const v = (...avail: boolean[]) => ({ nodes: avail.map((a) => ({ availableForSale: a })) });
const node = (title: string, extra: Record<string, unknown>) => ({
  id: title, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), status: "ACTIVE", onlineStoreUrl: null,
  publishedAt: "2026-10-01T00:00:00Z", featuredImage: null, priceRangeV2: { minVariantPrice: m("700") }, compareAtPriceRange: null, ...extra,
});
const NOT_TRACKED = node("The Inventory Not Tracked Snowboard", { totalInventory: 0, tracksInventory: false, variants: v(true) });
const SOLD_OUT = node("The Out of Stock Snowboard", { totalInventory: 0, tracksInventory: true, variants: v(false) });
const IN_STOCK = node("The Multi-location Snowboard", { totalInventory: 100, tracksInventory: true, variants: v(true) });
// Stock counted but Shopify says not for sale (e.g. held where it cannot sell online).
const COUNTED_NOT_SELLABLE = node("The Unsellable Snowboard", { totalInventory: 20, tracksInventory: true, variants: v(false) });
// "Continue selling when out of stock": 0 on hand, still for sale.
const OVERSELL = node("The Preorder Snowboard", { totalInventory: 0, tracksInventory: true, variants: v(true) });
const MIXED = node("The Complete Snowboard", { totalInventory: 10, tracksInventory: true, variants: v(false, false, true) });

const ctx = (nodes: unknown[], seen: string[] = []) =>
  ({ shop: "s.myshopify.com", customer: null, admin: { shop: "s.myshopify.com", graphql: async (q: string) => { seen.push(q); return q.includes("SearchProducts") ? { products: { nodes } } : {}; } } }) as never;

describe("Review2 D1 — product availability is Shopify's availableForSale", () => {
  it("untracked inventory is available although its count is 0", () => {
    expect(productAvailable(NOT_TRACKED as never)).toBe(true);
  });
  it("sold out is unavailable", () => {
    expect(productAvailable(SOLD_OUT as never)).toBe(false);
  });
  it("stock Shopify will not sell is unavailable although the count is 20", () => {
    expect(productAvailable(COUNTED_NOT_SELLABLE as never)).toBe(false);
  });
  it("continue-selling (oversell) with 0 on hand is available", () => {
    expect(productAvailable(OVERSELL as never)).toBe(true);
  });
  it("a product is available when any variant is", () => {
    expect(productAvailable(MIXED as never)).toBe(true);
  });
  it("a draft/archived product is never available", () => {
    expect(productAvailable({ ...IN_STOCK, status: "ARCHIVED" } as never)).toBe(false);
  });
  it("without variants (older callers) an untracked product is available and a 0 count is not", () => {
    expect(productAvailable({ status: "ACTIVE", totalInventory: 0, tracksInventory: false } as never)).toBe(true);
    expect(productAvailable({ status: "ACTIVE", totalInventory: 0, tracksInventory: true } as never)).toBe(false);
    expect(productAvailable({ status: "ACTIVE", totalInventory: 4 } as never)).toBe(true);
  });

  it("search_products asks Shopify for variant availability and marks only the sold-out ones", async () => {
    const seen: string[] = [];
    const out = await searchProducts({ query: "snowboard" }, ctx([NOT_TRACKED, SOLD_OUT, IN_STOCK, COUNTED_NOT_SELLABLE, OVERSELL], seen));
    const text = JSON.stringify(out);
    const q = seen.find((s) => s.includes("SearchProducts"))!;
    expect(q).toMatch(new RegExp(`variants\\(first: ${VARIANT_PROBE}\\) \\{ nodes \\{ availableForSale \\} \\}`));
    expect(q).toMatch(/tracksInventory/);
    expect(text).toMatch(/The Out of Stock Snowboard — [^•]*\(out of stock\)/);
    expect(text).toMatch(/The Unsellable Snowboard — [^•]*\(out of stock\)/);
    expect(text).not.toMatch(/Inventory Not Tracked Snowboard — [^•\\]*\(out of stock\)/);
    expect(text).not.toMatch(/Multi-location Snowboard — [^•\\]*\(out of stock\)/);
    expect(text).not.toMatch(/Preorder Snowboard — [^•\\]*\(out of stock\)/);
    const products = (out as { structuredContent?: { products?: Array<{ title: string; available: boolean }> } }).structuredContent?.products
      ?? JSON.parse(JSON.stringify(out)).structuredContent?.products;
    if (products) {
      const by = Object.fromEntries(products.map((p: { title: string; available: boolean }) => [p.title, p.available]));
      expect(by["The Inventory Not Tracked Snowboard"]).toBe(true);
      expect(by["The Unsellable Snowboard"]).toBe(false);
      expect(by["The Out of Stock Snowboard"]).toBe(false);
    }
  });

  it("get_product reports availability from the variants (untracked = available)", async () => {
    const admin = {
      shop: "s.myshopify.com",
      graphql: async (q: string) =>
        q.includes("GetProduct")
          ? { productByHandle: { id: "1", title: "The Inventory Not Tracked Snowboard", handle: "x", status: "ACTIVE", descriptionHtml: "", onlineStoreUrl: "https://s/products/x", publishedAt: "2026-01-01", priceRangeV2: { minVariantPrice: m("949.95") }, variants: { nodes: [{ id: "v", title: "Default Title", price: "949.95", availableForSale: true, inventoryQuantity: 0 }] } } }
          : {},
    };
    const out = await getProduct({ handle: "x" }, { shop: "s.myshopify.com", customer: null, admin } as never);
    expect(JSON.stringify(out)).toMatch(/"available":true/);
  });
});
