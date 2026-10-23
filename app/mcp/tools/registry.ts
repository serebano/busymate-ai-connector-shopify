/**
 * Connector tool registry — the tool list Busymate AI sees + their gates.
 *
 * Tiers map 1:1 onto the bmai published tool boundary
 * (mcp_connector_support_policies): public → identified → delegated → confirm.
 *   - public:    no store-data writes, anonymous callers.
 *   - identified: scoped to the launch-JWT customer subject (own orders/WISMO).
 *   - delegated: needs a runtime actor grant (identified customer).
 *   - confirm:   Busymate AI surfaces the payload + a confirm turn before running.
 *   - adminOnly: kept off the free-text LLM path (highest-risk writes).
 *
 */
import type { ToolContext, ToolResult } from "./types";
import { searchProducts, getProduct, listCollections } from "./products";
import { getOrderStatus, trackFulfillment, listMyOrders } from "./orders";
import { applyDiscount, createDraftOrder } from "./discounts";
import { cancelOrder, createRefund, updateShippingAddress } from "./returns";

export type Tier = "public" | "identified" | "delegated";

export interface ToolDef {
  name: string;
  description: string;
  tier: Tier;
  confirm: boolean;
  adminOnly: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

const str = (description: string) => ({ type: "string", description });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  // ── public ────────────────────────────────────────────────────────────────
  {
    name: "search_products",
    description: "Search the store catalog by keyword. Returns titles, prices (with the compare-at \"was\" price when on sale) and availability. For \"what is on sale\" questions set on_sale: true (query may be empty or a product type).",
    tier: "public",
    confirm: false,
    adminOnly: false,
    inputSchema: obj({ query: str("Search terms (may be empty with on_sale)"), first: { type: "number" }, on_sale: { type: "boolean", description: "Only products whose compare-at price is above their price" } }, []),
    handler: searchProducts,
  },
  {
    name: "get_product",
    description: "Get one product's details (variants, price, inventory, description).",
    tier: "public",
    confirm: false,
    adminOnly: false,
    inputSchema: obj({ handle: str("Product handle or id") }, ["handle"]),
    handler: getProduct,
  },
  {
    name: "list_collections",
    description: "List storefront collections.",
    tier: "public",
    confirm: false,
    adminOnly: false,
    inputSchema: obj({ first: { type: "number" } }),
    handler: listCollections,
  },
  // ── identified (scoped to the launch-JWT customer) ─────────────────────────
  {
    name: "get_order_status",
    description: "Get the status of the identified customer's order (WISMO).",
    tier: "identified",
    confirm: false,
    adminOnly: false,
    inputSchema: obj({ order_number: str("Order name/number, e.g. #1001") }, ["order_number"]),
    handler: getOrderStatus,
  },
  {
    name: "track_fulfillment",
    description: "Get tracking numbers/links for the identified customer's order.",
    tier: "identified",
    confirm: false,
    adminOnly: false,
    inputSchema: obj({ order_number: str("Order name/number") }, ["order_number"]),
    handler: trackFulfillment,
  },
  {
    name: "list_my_orders",
    description: "List recent orders belonging to the identified customer.",
    tier: "identified",
    confirm: false,
    adminOnly: false,
    inputSchema: obj({ first: { type: "number" } }),
    handler: listMyOrders,
  },
  // ── delegated + confirm (writes; refund cap enforced) ──────────────────────
  {
    name: "update_shipping_address",
    description: "Update the shipping address on an unfulfilled order (confirm required).",
    tier: "delegated",
    confirm: true,
    adminOnly: false,
    inputSchema: obj(
      {
        order_number: str("Order name/number"),
        // #2624 walk — was `obj({})` with additionalProperties:false, so EVERY address the
        // model sent was rejected by input validation ("tool rejected the input twice") and
        // a signed-in shopper could never change an address. Spell out the Shopify
        // MailingAddressInput fields the handler copies (returns.ts ADDRESS_FIELDS).
        address: obj(
          {
            address1: str("Street address"),
            address2: str("Apartment, suite, etc."),
            city: str("City"),
            company: str("Company"),
            country: str("Country name"),
            countryCode: str("ISO 3166-1 alpha-2 country code, e.g. US"),
            firstName: str("Recipient first name"),
            lastName: str("Recipient last name"),
            phone: str("Phone"),
            province: str("State/province name"),
            provinceCode: str("State/province code, e.g. IL"),
            zip: str("Postal/ZIP code"),
          },
          ["address1", "city", "zip"],
        ),
      },
      ["order_number", "address"],
    ),
    handler: updateShippingAddress,
  },
  {
    name: "apply_discount",
    description: "Apply a discount code to a draft/checkout (confirm required).",
    tier: "delegated",
    confirm: true,
    adminOnly: false,
    inputSchema: obj({ order_number: str("Order"), code: str("Discount code") }, ["code"]),
    handler: applyDiscount,
  },
  {
    name: "create_draft_order",
    description: "Create a draft order for the customer (confirm required).",
    tier: "delegated",
    confirm: true,
    adminOnly: false,
    inputSchema: obj({ line_items: { type: "array" } }, ["line_items"]),
    handler: createDraftOrder,
  },
  {
    name: "cancel_order",
    description: "Cancel the identified customer's order (confirm + adminOnly).",
    tier: "delegated",
    confirm: true,
    adminOnly: true,
    inputSchema: obj({ order_number: str("Order name/number"), reason: str("Reason") }, ["order_number"]),
    handler: cancelOrder,
  },
  {
    name: "create_refund",
    description:
      "Refund the identified customer's order (confirm + adminOnly; enforces the merchant refund cap — above cap escalates to a human).",
    tier: "delegated",
    confirm: true,
    adminOnly: true,
    inputSchema: obj(
      { order_number: str("Order"), amount_cents: { type: "number" }, reason: str("Reason") },
      ["order_number", "amount_cents"],
    ),
    handler: createRefund,
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function publicToolNames(): string[] {
  return TOOLS.filter((t) => t.tier === "public").map((t) => t.name);
}
