import { describe, expect, it } from "vitest";
import { getProduct, searchProducts } from "../app/mcp/tools/products";
import { getOrderStatus, trackFulfillment } from "../app/mcp/tools/orders";
import { toolByName } from "../app/mcp/tools/registry";
import { ONLINE_STORE_QUERY, onOnlineStore, storefrontProductUrl } from "../app/lib/onlineStore";
import { buildKnowledgeSources, hasReturnPolicy, KNOWLEDGE_KEYS, renderOrderHelp } from "../app/lib/kbSnapshot";
import type { ToolContext } from "../app/mcp/tools/types";

/**
 * src#2624 independent review, 2026-10-24 — the shopper-chat findings fixed in the
 * connector: X2 (unpublished product recommended with a 404 link), S1 (signed-in
 * tracking took three turns) and S7 (no return policy answered with a deflection).
 */

const SHOP = "bmai-independent-review-3.myshopify.com";
const m = (amount: string) => ({ amount, currencyCode: "USD" });
const board = (title: string, price: string, publishedAt: string | null) => ({
  id: title,
  title,
  handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  status: "ACTIVE",
  totalInventory: 5,
  // Password-protected dev store: onlineStoreUrl is null on EVERY product (measured live).
  onlineStoreUrl: null,
  publishedAt,
  featuredImage: null,
  priceRangeV2: { minVariantPrice: m(price), maxVariantPrice: m(price) },
  compareAtPriceRange: null,
});
// The live bmai-independent-review-3 catalog the reviewer asked about.
const CATALOG = [
  board("The Collection Snowboard: Hydrogen", "600.00", "2026-10-24T07:00:00Z"),
  board("The Multi-managed Snowboard", "629.95", "2026-10-24T07:00:00Z"),
  board("The Hidden Snowboard", "749.95", null),
  board("The Minimal Snowboard", "885.95", null),
];

function ctx(graphql: (q: string, v?: Record<string, unknown>) => unknown, customerId: string | null = null): ToolContext {
  return { shop: SHOP, customerId, confirmed: false, admin: { graphql: async (q: string, v?: Record<string, unknown>) => graphql(q, v) } } as never;
}

describe("X2 — only products published to the Online Store reach the shopper", () => {
  it("onOnlineStore: onlineStoreUrl OR publishedAt, never DRAFT/ARCHIVED, never a product published nowhere", () => {
    expect(onOnlineStore({ status: "ACTIVE", onlineStoreUrl: "https://s/products/a" })).toBe(true);
    expect(onOnlineStore({ status: "ACTIVE", onlineStoreUrl: null, publishedAt: "2026-10-01T00:00:00Z" })).toBe(true);
    expect(onOnlineStore({ status: "ACTIVE", onlineStoreUrl: null, publishedAt: null })).toBe(false);
    expect(onOnlineStore({ status: "DRAFT", onlineStoreUrl: "https://s/products/a", publishedAt: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(onOnlineStore({ status: "ARCHIVED", publishedAt: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(storefrontProductUrl(SHOP, { status: "ACTIVE", handle: "the-hidden-snowboard", publishedAt: null })).toBeNull();
    expect(storefrontProductUrl(SHOP, { status: "ACTIVE", handle: "x", publishedAt: "2026-10-01T00:00:00Z" })).toBe(`https://${SHOP}/products/x`);
  });

  it("search_products asks Shopify for published products and drops any unpublished node it still gets", async () => {
    const seen: string[] = [];
    const r = await searchProducts({ query: "snowboard", sort: "price_asc" }, ctx((_q, v) => {
      seen.push(String(v?.q));
      return { products: { nodes: CATALOG } };
    }));
    expect(seen[0]).toBe(`${ONLINE_STORE_QUERY} snowboard`);
    const text = r.content[0]!.text;
    expect(text).not.toMatch(/Hidden|Minimal/);
    const sc = r.structuredContent as { total: number; products: Array<{ title: string; url: string | null }>; mostExpensive: { title: string } };
    expect(sc.total).toBe(2);
    expect(sc.mostExpensive.title).toBe("The Multi-managed Snowboard");
    // A real storefront address for every product shown, built from the shop when Shopify gives none.
    expect(sc.products[0]!.url).toBe(`https://${SHOP}/products/the-collection-snowboard-hydrogen`);
  });

  it("get_product answers an unpublished product exactly like a missing one (no details, no link)", async () => {
    const hidden = CATALOG[2]!;
    const r = await getProduct({ handle: "the-hidden-snowboard" }, ctx(() => ({ productByHandle: { ...hidden, descriptionHtml: "<p>secret</p>", variants: { nodes: [] } } })));
    expect(r.content[0]!.text).toBe("No product found for “the-hidden-snowboard”.");
    expect(r.structuredContent).toEqual({ handle: "the-hidden-snowboard", product: null });
    const pub = CATALOG[0]!;
    const ok = await getProduct({ handle: pub.handle }, ctx(() => ({ productByHandle: { ...pub, descriptionHtml: "<p>Board</p>", variants: { nodes: [] } } })));
    expect((ok.structuredContent as { product: { url: string } }).product.url).toBe(`https://${SHOP}/products/${pub.handle}`);
  });

  it("the trained catalog leaves the Hidden and Minimal snowboards out (a re-train replaces the catalog source by key)", () => {
    const out = buildKnowledgeSources({ shop: SHOP, shopName: "Review 3", products: CATALOG, policies: [], pages: [], generatedAt: "2026-10-24T09:00:00Z" });
    const products = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.products)!.content;
    expect(products).toContain("The Collection Snowboard: Hydrogen");
    expect(products).not.toMatch(/Hidden|Minimal|the-hidden-snowboard/);
    expect(out.counts.products).toBe(2);
  });
});

describe("S1 — a signed-in shopper gets their latest order's tracking without typing a number", () => {
  const orders = [
    { id: "gid://shopify/Order/2", name: "#1002", displayFulfillmentStatus: "FULFILLED", displayFinancialStatus: "PAID", fulfillments: [{ trackingInfo: [{ company: "UPS", number: "1Z999AA10123456785", url: "https://ups.example/1Z" }] }] },
    { id: "gid://shopify/Order/1", name: "#1001", displayFulfillmentStatus: "UNFULFILLED", displayFinancialStatus: "PAID", fulfillments: [] },
  ];
  const customerOrders = (seen: Array<Record<string, unknown> | undefined>) => (_q: string, v?: Record<string, unknown>) => {
    seen.push(v);
    return { customer: { orders: { nodes: v?.q ? orders.filter((o) => `name:${o.name}` === v.q) : orders } } };
  };

  it("order_number is optional on track_fulfillment and get_order_status (never a provenance gap)", () => {
    for (const name of ["track_fulfillment", "get_order_status"]) {
      const schema = toolByName(name)!.inputSchema as { required: string[]; properties: Record<string, unknown> };
      expect(schema.required).toEqual([]);
      expect(schema.properties.order_number).toBeTruthy();
      expect(toolByName(name)!.description).toMatch(/most recent order/);
    }
    // The writes keep a REQUIRED order number: the shopper names the order they change.
    expect((toolByName("cancel_order")!.inputSchema as { required: string[] }).required).toContain("order_number");
  });

  it("no number → the customer's most recent order, scoped to them, with their other recent orders listed", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const r = await trackFulfillment({}, ctx(customerOrders(seen), "42"));
    expect(seen[0]).toMatchObject({ customerId: "gid://shopify/Customer/42", q: null });
    expect(r.content[0]!.text).toBe("Tracking for #1002:\n• UPS 1Z999AA10123456785 — https://ups.example/1Z\nYour other recent orders: #1001 (unfulfilled).");
    expect(r.structuredContent).toMatchObject({ order: "#1002", mostRecent: true, otherOrders: ["#1001"] });
    const s = await getOrderStatus({}, ctx(customerOrders([]), "42"));
    expect(s.content[0]!.text).toMatch(/^Your most recent order — #1002: fulfilled · tracking UPS 1Z999AA10123456785/);
  });

  it("an explicit number still looks up exactly that order; a guest is still refused; no orders is said plainly", async () => {
    const r = await trackFulfillment({ order_number: "1001" }, ctx(customerOrders([]), "42"));
    expect(r.content[0]!.text).toBe("#1001 isn't showing tracking yet (status: unfulfilled).");
    const guest = await trackFulfillment({}, ctx(customerOrders([]), null));
    expect(guest.isError).toBe(true);
    const none = await trackFulfillment({}, ctx(() => ({ customer: { orders: { nodes: [] } } }), "42"));
    expect(none.content[0]!.text).toBe("I don't see any orders on your account yet.");
  });
});

describe("S7 — the return-policy fact comes from the store's own policies", () => {
  it("no published refund policy → the how-to says so plainly (no hand-off as the answer)", () => {
    const help = renderOrderHelp(SHOP, "Review 3", [{ type: "CONTACT_INFORMATION", title: "Contact", body: "<p>hi@example.com</p>" }]);
    expect(help).toContain("Review 3 has NOT published a return or refund policy");
    expect(help).toMatch(/say plainly that the store has not published a return policy/);
    expect(help).not.toMatch(/Returns and refunds are handled by the store's team/);
    expect(help).not.toMatch(/starting a return/);
  });

  it("a published refund policy → answer from it; an empty one counts as none", () => {
    expect(hasReturnPolicy([{ type: "REFUND_POLICY", title: "Refund policy", body: "<p>30 days</p>" }])).toBe(true);
    expect(hasReturnPolicy([{ type: "REFUND_POLICY", title: "Refund policy", body: "<p> </p>" }])).toBe(false);
    const out = buildKnowledgeSources({ shop: SHOP, shopName: "Review 3", products: [], policies: [{ type: "REFUND_POLICY", title: "Refund policy", body: "<p>30 days</p>" }], pages: [], generatedAt: "2026-10-24T09:00:00Z" });
    const help = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.orderHelp)!.content;
    expect(help).toContain('Review 3 has published one; it is under "Store policies"');
  });
});
