import { describe, expect, it } from "vitest";
import { priceExtremes, searchProducts, sortByPrice } from "../app/mcp/tools/products";
import { toolByName } from "../app/mcp/tools/registry";

const m = (amount: string) => ({ amount, currencyCode: "USD" });
const node = (title: string, price: string | null) => ({ id: title, title, handle: title.toLowerCase().replace(/\s+/g, "-"), status: "ACTIVE", totalInventory: 5, onlineStoreUrl: null, featuredImage: null, priceRangeV2: price === null ? null : { minVariantPrice: m(price) }, compareAtPriceRange: null });
const ctx = (nodes: unknown[], seen: Array<{ q: string; n: number }> = []) => ({ admin: { graphql: async (_q: string, v?: { q: string; n: number }) => { seen.push(v ?? { q: "", n: 0 }); return { products: { nodes } }; } }, customer: null } as never);

// The live Test 12 catalog the shopper asked about (src#2679), in Shopify's relevance order.
const TEST12 = [
  node("The Multi-managed Snowboard", "629.95"),
  node("The Complete Snowboard", "699.95"),
  node("The Multi-location Snowboard", "729.95"),
  node("The Collection Snowboard: Hydrogen", "600.00"),
  node("The 3p Fulfilled Snowboard", "2629.95"),
  node("No price board", null),
];

describe("src#2679 — 'which snowboard is cheapest?' is ordered in code, not by the model", () => {
  it("sortByPrice orders numerically (600.00 before 629.95), unknown prices last", () => {
    const rows = TEST12.map((n) => ({ title: n.title, priceAmount: n.priceRangeV2 ? Number(n.priceRangeV2.minVariantPrice.amount) : null })) as never[];
    expect(sortByPrice(rows, "asc").map((p: { title: string }) => p.title)).toEqual([
      "The Collection Snowboard: Hydrogen", "The Multi-managed Snowboard", "The Complete Snowboard", "The Multi-location Snowboard", "The 3p Fulfilled Snowboard", "No price board",
    ]);
    expect((sortByPrice(rows, "desc")[0] as { title: string }).title).toBe("The 3p Fulfilled Snowboard");
    expect(priceExtremes([])).toBeNull();
  });

  it("sort: price_asc reads the whole match set, lists cheapest first, and names the cheapest", async () => {
    const seen: Array<{ q: string; n: number }> = [];
    const r = await searchProducts({ query: "snowboard", sort: "price_asc", first: 3 }, ctx(TEST12, seen));
    expect(seen[0]!.n).toBe(250);
    const text = r.content.map((c) => c.text).join("\n");
    expect(text).toMatch(/^6 products matching “snowboard”, sorted by price \(lowest first\) \(showing 3 of 6\):\n• The Collection Snowboard: Hydrogen — 600\.00 USD\n• The Multi-managed Snowboard — 629\.95 USD/);
    expect(text).toMatch(/Lowest price of all matches: The Collection Snowboard: Hydrogen — 600\.00 USD\. Highest: The 3p Fulfilled Snowboard — 2629\.95 USD\./);
    const sc = r.structuredContent as { sort: string; total: number; cheapest: { title: string; priceAmount: number }; products: Array<{ priceAmount: number | null; currency: string | null }> };
    expect(sc.sort).toBe("price_asc");
    expect(sc.total).toBe(6);
    expect(sc.cheapest).toMatchObject({ title: "The Collection Snowboard: Hydrogen", priceAmount: 600 });
    expect(sc.products.map((p) => p.priceAmount)).toEqual([600, 629.95, 699.95]);
    expect(sc.products[0]!.currency).toBe("USD");
  });

  it("without sort the relevance order is kept, but the lowest price is still stated (scoped to what was returned)", async () => {
    const seen: Array<{ q: string; n: number }> = [];
    const r = await searchProducts({ query: "snowboard" }, ctx(TEST12, seen));
    expect(seen[0]!.n).toBe(10);
    const sc = r.structuredContent as { sort: string; products: Array<{ title: string }>; cheapest: { title: string } };
    expect(sc.sort).toBe("relevance");
    expect(sc.products[0]!.title).toBe("The Multi-managed Snowboard");
    expect(sc.cheapest.title).toBe("The Collection Snowboard: Hydrogen");
    expect(r.content[0]!.text).toMatch(/Lowest price of these 6: The Collection Snowboard: Hydrogen — 600\.00 USD\./);
  });

  it("an unknown sort value falls back to relevance (never an error), and the schema declares the enum", async () => {
    const r = await searchProducts({ query: "snowboard", sort: "cheap" }, ctx(TEST12));
    expect((r.structuredContent as { sort: string }).sort).toBe("relevance");
    const schema = toolByName("search_products")!.inputSchema as { properties: { sort: { enum: string[] } }; required: string[] };
    expect(schema.properties.sort.enum).toEqual(["relevance", "price_asc", "price_desc"]);
    expect(schema.required).toEqual([]);
  });

  it("a single match states no extremes line", async () => {
    const r = await searchProducts({ query: "hydrogen", sort: "price_asc" }, ctx([TEST12[3]]));
    expect(r.content[0]!.text).not.toMatch(/Lowest price/);
  });
});
