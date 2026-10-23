import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolByName } from "../app/mcp/tools/registry";
import type { ToolContext, ToolResult } from "../app/mcp/tools/types";

/**
 * Per-tool integration proof: every connector tool issues a REAL Admin GraphQL
 * operation and maps the response to a concrete payload — no leftover TODO stub
 * text, and a structured result Busymate AI can act on. The Admin client is a canned
 * responder keyed by operation, so this runs with no live shop.
 */

// A responder that dispatches on the GraphQL operation name in the query string.
function mockAdmin(shop = "acme.myshopify.com") {
  const seen: Array<{ query: string; vars: Record<string, unknown> }> = [];
  const graphql = async (query: string, vars?: Record<string, unknown>) => {
    seen.push({ query, vars: vars ?? {} });
    const has = (op: string) => query.includes(op);

    if (has("SearchProducts"))
      return {
        products: {
          nodes: [
            {
              id: "gid://shopify/Product/1",
              title: "Aurora Tee",
              handle: "aurora-tee",
              status: "ACTIVE",
              onlineStoreUrl: "https://acme.example/products/aurora-tee",
              totalInventory: 12,
              featuredImage: { url: "https://cdn/x.png" },
              priceRangeV2: { minVariantPrice: { amount: "29.00", currencyCode: "USD" } },
            },
          ],
        },
      };
    if (has("GetProduct"))
      return {
        productByHandle: {
          id: "gid://shopify/Product/1",
          title: "Aurora Tee",
          handle: "aurora-tee",
          status: "ACTIVE",
          descriptionHtml: "<p>Soft <b>organic</b> cotton.</p>",
          onlineStoreUrl: "https://acme.example/products/aurora-tee",
          priceRangeV2: { minVariantPrice: { amount: "29.00", currencyCode: "USD" } },
          variants: {
            nodes: [{ id: "gid://shopify/ProductVariant/9", title: "M", price: "29.00", availableForSale: true, inventoryQuantity: 5, sku: "AT-M" }],
          },
        },
      };
    if (has("Collections"))
      return { collections: { nodes: [{ id: "gid://shopify/Collection/1", title: "Summer", handle: "summer", productsCount: { count: 8 } }] } };

    if (has("CustomerOrders"))
      return {
        customer: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/555",
                name: "#1001",
                processedAt: "2026-08-01T00:00:00Z",
                cancelledAt: null,
                displayFulfillmentStatus: "IN_TRANSIT",
                displayFinancialStatus: "PAID",
                totalPriceSet: { presentmentMoney: { amount: "58.00", currencyCode: "USD" } },
                fulfillments: [
                  { status: "SUCCESS", deliveredAt: null, estimatedDeliveryAt: "2026-08-10T00:00:00Z", trackingInfo: [{ number: "1Z999", url: "https://track/1Z999", company: "UPS" }] },
                ],
                lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", title: "Aurora Tee", quantity: 2 }] },
              },
            ],
          },
        },
      };
    if (has("OrderTransactions"))
      return { order: { transactions: [{ id: "gid://shopify/OrderTransaction/7", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments" }] } };
    if (has("RefundCreate"))
      return { refundCreate: { refund: { id: "gid://shopify/Refund/3", totalRefundedSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } } }, userErrors: [] } };
    if (has("Returnable"))
      return { order: { returnableFulfillments: { nodes: [{ returnableFulfillmentLineItems: { nodes: [{ fulfillmentLineItem: { id: "gid://shopify/FulfillmentLineItem/2" }, quantity: 1 }] } }] } } };
    if (has("ReturnCreate"))
      return { returnCreate: { return: { id: "gid://shopify/Return/4", name: "#1001-R1", status: "OPEN" }, userErrors: [] } };
    if (has("OrderCancel")) return { orderCancel: { job: { id: "gid://shopify/Job/1" }, orderCancelUserErrors: [] } };
    if (has("OrderUpdate")) return { orderUpdate: { order: { id: "gid://shopify/Order/555" }, userErrors: [] } };
    if (has("DiscountByCode")) return { codeDiscountNodeByCode: { id: "gid://shopify/DiscountCodeNode/1", codeDiscount: { title: "SAVE10", status: "ACTIVE", summary: "10% off" } } };
    if (has("DraftOrderCreate"))
      return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/2", name: "#D2", invoiceUrl: "https://acme.example/invoices/2", totalPriceSet: { presentmentMoney: { amount: "29.00", currencyCode: "USD" } } }, userErrors: [] } };
    return {};
  };
  return { admin: { shop, graphql }, seen };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const { admin } = mockAdmin();
  return { shop: "acme.myshopify.com", customerId: "42", confirmed: true, admin, ...overrides };
}

async function run(name: string, args: Record<string, unknown>, overrides: Partial<ToolContext> = {}): Promise<ToolResult> {
  const tool = toolByName(name);
  if (!tool) throw new Error(`no such tool ${name}`);
  return tool.handler(args, ctx(overrides));
}

function text(r: ToolResult): string {
  return r.content.map((c) => c.text).join(" ");
}

// The exact args each tool is exercised with — one entry per registered tool.
const CASES: Record<string, Record<string, unknown>> = {
  search_products: { query: "tee" },
  get_product: { handle: "aurora-tee" },
  list_collections: {},
  get_order_status: { order_number: "1001" },
  track_fulfillment: { order_number: "1001" },
  list_my_orders: {},
  update_shipping_address: { order_number: "1001", address: { address1: "1 New St", city: "Denver", zip: "80014", countryCode: "US" } },
  apply_discount: { order_number: "1001", code: "SAVE10" },
  create_draft_order: { line_items: [{ variant_id: "9", quantity: 1 }] },
  cancel_order: { order_number: "1001", reason: "customer" },
  start_return: { order_number: "1001", line_items: [] },
  create_refund: { order_number: "1001", amount_cents: 1000, reason: "damaged" },
};

describe("connector tools — real payloads, no TODO stubs", () => {
  it("every registered tool returns a non-error result with NO TODO text", async () => {
    for (const [name, args] of Object.entries(CASES)) {
      const r = await run(name, args);
      const t = text(r);
      expect(t, `${name} still returns TODO stub text`).not.toMatch(/TODO/i);
      expect(r.isError, `${name} unexpectedly errored: ${t}`).not.toBe(true);
    }
  });

  it("no tool SOURCE file still carries a TODO(P#) stub", () => {
    const dir = join(process.cwd(), "app", "mcp", "tools");
    for (const f of ["products.ts", "orders.ts", "returns.ts", "discounts.ts"]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, `${f} still contains a TODO(P#) stub`).not.toMatch(/TODO\(P\d/);
    }
  });

  it("search_products maps GraphQL nodes to concise results", async () => {
    const r = await run("search_products", { query: "tee" });
    const sc = r.structuredContent as { products: Array<{ title: string; price: string; available: boolean }> };
    expect(sc.products[0]).toMatchObject({ title: "Aurora Tee", price: "29.00 USD", available: true });
    expect(text(r)).toContain("Aurora Tee");
  });

  it("get_order_status is customer-scoped WISMO with tracking", async () => {
    const r = await run("get_order_status", { order_number: "1001" });
    const sc = r.structuredContent as { order: { name: string; tracking: Array<{ number: string }> } };
    expect(sc.order.name).toBe("#1001");
    expect(sc.order.tracking[0].number).toBe("1Z999");
    expect(text(r)).toMatch(/#1001/);
  });

  it("get_order_status refuses a guest (no customer subject) — never a store-wide read", async () => {
    const r = await run("get_order_status", { order_number: "1001" }, { customerId: null });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/signed in/i);
  });

  it("create_refund enforces the refund cap (above-cap escalates to a human)", async () => {
    const r = await run("create_refund", { order_number: "1001", amount_cents: 999999 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/above the automatic limit/i);
  });

  it("create_refund below cap issues a real refundCreate and reports the amount", async () => {
    const r = await run("create_refund", { order_number: "1001", amount_cents: 1000 });
    const sc = r.structuredContent as { refundId: string; amount: string };
    expect(sc.refundId).toBe("gid://shopify/Refund/3");
    expect(text(r)).toMatch(/refunded/i);
  });

  it("start_return builds returnable line items and opens a returnCreate", async () => {
    const r = await run("start_return", { order_number: "1001" });
    const sc = r.structuredContent as { returnId: string; status: string };
    expect(sc.returnId).toBe("gid://shopify/Return/4");
    expect(sc.status).toBe("OPEN");
  });

  it("apply_discount validates the code and returns a checkout apply link", async () => {
    const r = await run("apply_discount", { order_number: "1001", code: "SAVE10" });
    const sc = r.structuredContent as { valid: boolean; applyUrl: string };
    expect(sc.valid).toBe(true);
    expect(sc.applyUrl).toContain("/discount/SAVE10");
  });

  it("create_draft_order creates a real draft with an invoice URL", async () => {
    const r = await run("create_draft_order", { line_items: [{ variant_id: "9", quantity: 1 }] });
    const sc = r.structuredContent as { draftId: string; invoiceUrl: string };
    expect(sc.draftId).toBe("gid://shopify/DraftOrder/2");
    expect(sc.invoiceUrl).toContain("/invoices/2");
  });
});

describe("#2624 — update_shipping_address accepts a real address", () => {
  it("the address schema names every field the handler copies (was an empty closed object)", async () => {
    const { toolByName } = await import("../app/mcp/tools/registry");
    const schema = toolByName("update_shipping_address")!.inputSchema as { properties: { address: { properties: Record<string, unknown>; required: string[] } } };
    const props = Object.keys(schema.properties.address.properties);
    for (const k of ["address1", "address2", "city", "country", "countryCode", "province", "provinceCode", "zip"]) expect(props).toContain(k);
    expect(schema.properties.address.required).toEqual(["address1", "city", "zip"]);
  });
});
