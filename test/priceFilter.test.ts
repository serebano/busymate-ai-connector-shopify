import { describe, expect, it } from "vitest";
import { searchProducts, withinPrice } from "../app/mcp/tools/products";
import { toolByName } from "../app/mcp/tools/registry";

/**
 * 2026-11-26 v12-review-1126 (guest storefront chat) — "Which snowboards do you sell under 700 dollars?" was
 * answered "We have four snowboards under $700 … That's three, not four." The tool returned the whole catalog and
 * the model filtered prices itself, counting the out-of-stock Gift Card (it matches "snowboard" through its vendor).
 * A price condition is applied in code and the reply states the exact count.
 */
const m = (amount: string) => ({ amount, currencyCode: "USD" });
const node = (title: string, price: string, extra: Record<string, unknown> = {}) => ({ id: title, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), status: "ACTIVE", totalInventory: 5, onlineStoreUrl: null, publishedAt: "2026-10-01T00:00:00Z", featuredImage: null, priceRangeV2: { minVariantPrice: m(price) }, compareAtPriceRange: null, ...extra });
const ctx = (nodes: unknown[], seen: Array<{ q: string; n: number }> = []) => ({ admin: { graphql: async (_q: string, v?: { q: string; n: number }) => { seen.push(v ?? { q: "", n: 0 }); return { products: { nodes } }; } }, customer: null } as never);

// The v12-review-1126 generated test catalog, as the live tool read it for "snowboard".
const V12 = [
  node("Gift Card", "10.00", { isGiftCard: true, totalInventory: 0 }),
  node("The Collection Snowboard: Hydrogen", "600.00"),
  node("The Multi-managed Snowboard", "629.95"),
  node("The Complete Snowboard", "699.95"),
  node("The Multi-location Snowboard", "729.95"),
  node("The Collection Snowboard: Liquid", "749.95"),
  node("The Compare at Price Snowboard", "785.95"),
  node("The Videographer Snowboard", "885.95"),
  node("The Collection Snowboard: Oxygen", "1025.00"),
  node("The 3p Fulfilled Snowboard", "2629.95"),
  node("Snowboard Wax (price on request)", "700.00"),
];

describe("price conditions are applied in code, and the count is the tool's", () => {
  it("under_price is strictly below; max_price/min_price are inclusive; an unknown price never matches", () => {
    expect(withinPrice({ priceAmount: 700 }, { min: null, max: null, under: 700 })).toBe(false);
    expect(withinPrice({ priceAmount: 699.95 }, { min: null, max: null, under: 700 })).toBe(true);
    expect(withinPrice({ priceAmount: 700 }, { min: null, max: 700, under: null })).toBe(true);
    expect(withinPrice({ priceAmount: 500 }, { min: 500, max: null, under: null })).toBe(true);
    expect(withinPrice({ priceAmount: null }, { min: 1, max: null, under: null })).toBe(false);
    expect(withinPrice({ priceAmount: null }, { min: null, max: null, under: null })).toBe(true);
  });

  it("'snowboards under $700' reads the whole catalog and states the exact count; the gift card is named as one", async () => {
    const seen: Array<{ q: string; n: number }> = [];
    const r = await searchProducts({ query: "snowboard", under_price: 700, sort: "price_asc" }, ctx(V12, seen));
    expect(seen[0]!.n).toBe(250);
    const text = r.content.map((c) => c.text).join("\n");
    expect(text).toMatch(/^4 products matching “snowboard” priced under 700\.00 USD, sorted by price \(lowest first\):\n• Gift Card \(gift card\) — 10\.00 USD \(out of stock\)\n• The Collection Snowboard: Hydrogen/);
    expect(text).toMatch(/\n1 of these 4 is a gift card, not “snowboard”\./);
    expect(text).not.toMatch(/Wax|Multi-location/);
    const sc = r.structuredContent as { total: number; giftCards: number; priceFilter: unknown; products: Array<{ title: string; giftCard: boolean }> };
    expect(sc.total).toBe(4);
    expect(sc.giftCards).toBe(1);
    expect(sc.priceFilter).toEqual({ minPrice: null, maxPrice: null, underPrice: 700 });
    expect(sc.products.filter((p) => !p.giftCard).map((p) => p.title)).toEqual(["The Collection Snowboard: Hydrogen", "The Multi-managed Snowboard", "The Complete Snowboard"]);
  });

  it("a range ('between $700 and $800') with max_price inclusive", async () => {
    const r = await searchProducts({ query: "snowboard", min_price: 700, max_price: 800 }, ctx(V12));
    const sc = r.structuredContent as { total: number; products: Array<{ title: string }> };
    expect(sc.products.map((p) => p.title)).toEqual(["The Multi-location Snowboard", "The Collection Snowboard: Liquid", "The Compare at Price Snowboard", "Snowboard Wax (price on request)"]);
    expect(sc.total).toBe(4);
    expect(r.content[0]!.text).toMatch(/^4 products matching “snowboard” priced at least 700\.00 USD and at most 800\.00 USD:/);
  });

  it("nothing in range says so with the condition, and string amounts ('$700') are read", async () => {
    const r = await searchProducts({ query: "snowboard", under_price: "$5" }, ctx(V12));
    expect(r.content[0]!.text).toBe("No products match “snowboard” priced under 5.00 USD.");
    expect((r.structuredContent as { total: number }).total).toBe(0);
  });

  it("no price condition keeps today's output (no filter, no gift-card line without one)", async () => {
    const r = await searchProducts({ query: "board" }, ctx(V12.slice(1, 3)));
    expect(r.content[0]!.text).toMatch(/^2 products matching “board”:/);
    expect((r.structuredContent as { priceFilter: unknown }).priceFilter).toBeNull();
  });

  it("the schema declares the three bounds as optional numbers", () => {
    const schema = toolByName("search_products")!.inputSchema as { properties: Record<string, { type: string }>; required: string[] };
    expect(schema.properties.under_price!.type).toBe("number");
    expect(schema.properties.max_price!.type).toBe("number");
    expect(schema.properties.min_price!.type).toBe("number");
    expect(schema.required).toEqual([]);
  });
});
