import { describe, expect, it } from "vitest";
import { saleOf, searchProducts } from "../app/mcp/tools/products";

const m = (amount: string) => ({ amount, currencyCode: "USD" });
const node = (title: string, price: string, was?: string) => ({ id: title, title, handle: title.toLowerCase().replace(/\s+/g, "-"), status: "ACTIVE", totalInventory: 5, onlineStoreUrl: null, featuredImage: null, priceRangeV2: { minVariantPrice: m(price) }, compareAtPriceRange: was ? { minVariantCompareAtPrice: m(was) } : null });
const ctx = (nodes: unknown[], seen: string[] = []) => ({ admin: { graphql: async (_q: string, v?: { q: string }) => { seen.push(v?.q ?? ""); return { products: { nodes } }; } }, customer: null } as never);

describe("src#2624 reviewer F13 — compare-at prices answer 'what is on sale?'", () => {
  it("saleOf: only a compare-at above the price is a sale", () => {
    expect(saleOf(m("785.95"), m("885.95"))).toBe("885.95 USD");
    expect(saleOf(m("100"), m("100"))).toBeNull();
    expect(saleOf(m("100"), null)).toBeNull();
  });
  it("search_products lists the 'was' price and on_sale:true filters to sale items (no 'sale' keyword sent to Shopify)", async () => {
    const seen: string[] = [];
    const nodes = [node("The Compare at Price Snowboard", "785.95", "885.95"), node("The Complete Snowboard", "699.95")];
    const all = await searchProducts({ query: "snowboard" }, ctx(nodes));
    expect(JSON.stringify(all)).toMatch(/on sale, was 885\.95 USD/);
    const sale = await searchProducts({ query: "snowboards on sale", on_sale: true }, ctx(nodes, seen));
    const text = JSON.stringify(sale);
    expect(text).toMatch(/1 product on sale/);
    expect(text).toMatch(/Compare at Price Snowboard/);
    expect(text).not.toMatch(/Complete Snowboard/);
    expect(seen[0]).not.toMatch(/sale/);
  });
});

describe("src#2624 reviewer F13 — the trained catalog says what is on sale", () => {
  it("renders 'On sale: yes (compare-at price …)' only for sale items", async () => {
    const { buildKnowledgeSources, KNOWLEDGE_KEYS } = await import("../app/lib/kbSnapshot");
    const p = (title: string, price: string, was?: string) => ({ title, handle: title, status: "ACTIVE", onlineStoreUrl: `https://s/products/${title}`, priceRangeV2: { minVariantPrice: m(price), maxVariantPrice: m(price) }, compareAtPriceRange: was ? { minVariantCompareAtPrice: m(was) } : null });
    const out = buildKnowledgeSources({ shop: "s.myshopify.com", products: [p("sale-board", "785.95", "885.95"), p("full-board", "699.95", "699.95")], policies: [], pages: [], generatedAt: "2026-10-24T00:00:00Z" });
    const c = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.products)!.content;
    expect(c).toMatch(/sale-board[\s\S]*On sale: yes \(compare-at price 885\.95 USD\)/);
    expect(c.match(/On sale/g)).toHaveLength(1);
  });
});
