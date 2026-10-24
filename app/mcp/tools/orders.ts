import type { ToolContext, ToolResult } from "./types";
import { errorResult, textResult } from "./types";
import { findCustomerOrder, listCustomerOrders, summarizeOrder, type CustomerOrder } from "./orderLookup";

/**
 * Identified reads — MUST be scoped to ctx.customerId (the launch-JWT subject).
 * A missing customer id is a fail-closed refusal, never a store-wide read. Every
 * lookup goes through `customer(id).orders(...)` (orderLookup.ts), so a customer
 * only ever sees their OWN orders.
 */
function requireCustomer(ctx: ToolContext): ToolResult | null {
  if (!ctx.customerId) {
    return errorResult(
      "This needs you to be signed in to the store so I can look up your own orders.",
    );
  }
  return null;
}

function notFound(orderNumber: unknown): ToolResult {
  return textResult(
    `I couldn't find an order ${String(orderNumber ?? "")} on your account. Please double-check the order number.`,
    { order: null },
  );
}

/** Concise WISMO fields Busymate AI cites back to the shopper. */
function orderStatusPayload(order: CustomerOrder) {
  const tracking = order.fulfillments.flatMap((f) =>
    f.trackingInfo.map((t) => ({ company: t.company, number: t.number, url: t.url })),
  );
  return {
    name: order.name,
    fulfillmentStatus: order.displayFulfillmentStatus,
    financialStatus: order.displayFinancialStatus,
    cancelled: Boolean(order.cancelledAt),
    total: order.totalPrice ? `${order.totalPrice.amount} ${order.totalPrice.currencyCode}` : null,
    tracking,
    estimatedDelivery: order.fulfillments.map((f) => f.estimatedDeliveryAt).find(Boolean) ?? null,
  };
}

/**
 * src#2624 review S1 — "Where is my latest order?" → "tracking?" took THREE turns for a
 * signed-in shopper: `order_number` was REQUIRED, the number the assistant had just read
 * back (#1002) was not typed by the shopper, so the platform's argument-provenance guard
 * withheld it and the shopper was asked to type it. The customer is identified, so their
 * own orders are the context: with no number, the order is their MOST RECENT one, and the
 * reply lists their other recent orders so they can pick another in the same turn.
 */
async function resolveOrder(
  ctx: ToolContext,
  orderNumber: unknown,
): Promise<{ order: CustomerOrder | null; others: CustomerOrder[]; implicit: boolean }> {
  if (String(orderNumber ?? "").trim()) {
    return { order: await findCustomerOrder(ctx, orderNumber), others: [], implicit: false };
  }
  const recent = await listCustomerOrders(ctx, 5);
  return { order: recent[0] ?? null, others: recent.slice(1), implicit: true };
}

function noOrders(): ToolResult {
  return textResult("I don't see any orders on your account yet.", { order: null, orders: [] });
}

/** "Your other recent orders: #1001 · #999" — only when the order was picked for them. */
function otherOrdersLine(others: CustomerOrder[]): string {
  if (others.length === 0) return "";
  return `\nYour other recent orders: ${others.map((o) => `${o.name} (${o.displayFulfillmentStatus.toLowerCase().replace(/_/g, " ")})`).join(" · ")}.`;
}

export async function getOrderStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const guard = requireCustomer(ctx);
  if (guard) return guard;
  const { order, others, implicit } = await resolveOrder(ctx, args.order_number);
  if (!order) return implicit ? noOrders() : notFound(args.order_number);
  return textResult(`${implicit ? "Your most recent order — " : ""}${summarizeOrder(order)}${otherOrdersLine(others)}`, {
    order: orderStatusPayload(order),
    ...(implicit ? { mostRecent: true, otherOrders: others.map((o) => o.name) } : {}),
  });
}

export async function trackFulfillment(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const guard = requireCustomer(ctx);
  if (guard) return guard;
  const { order, others, implicit } = await resolveOrder(ctx, args.order_number);
  if (!order) return implicit ? noOrders() : notFound(args.order_number);
  const more = otherOrdersLine(others);
  const recent = implicit ? { mostRecent: true, otherOrders: others.map((o) => o.name) } : {};

  const tracking = order.fulfillments.flatMap((f) =>
    f.trackingInfo.map((t) => ({ company: t.company, number: t.number, url: t.url })),
  );
  if (tracking.length === 0) {
    return textResult(
      `${order.name} isn't showing tracking yet (status: ${order.displayFulfillmentStatus.toLowerCase().replace(/_/g, " ")}).${more}`,
      { order: order.name, tracking: [], ...recent },
    );
  }
  const lines = tracking.map(
    (t) => `• ${t.company ?? "Carrier"} ${t.number ?? ""}${t.url ? ` — ${t.url}` : ""}`.trim(),
  );
  return textResult(`Tracking for ${order.name}:\n${lines.join("\n")}${more}`, {
    order: order.name,
    tracking,
    ...recent,
  });
}

export async function listMyOrders(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const guard = requireCustomer(ctx);
  if (guard) return guard;
  const first = Number(args.first ?? 5) || 5;
  const orders = await listCustomerOrders(ctx, first);
  if (orders.length === 0) {
    return textResult("I don't see any orders on your account yet.", { orders: [] });
  }
  const summaries = orders.map((o) => ({
    name: o.name,
    processedAt: o.processedAt,
    fulfillmentStatus: o.displayFulfillmentStatus,
    total: o.totalPrice ? `${o.totalPrice.amount} ${o.totalPrice.currencyCode}` : null,
  }));
  const lines = summaries.map(
    (o) => `• ${o.name}${o.total ? ` — ${o.total}` : ""} · ${o.fulfillmentStatus.toLowerCase().replace(/_/g, " ")}`,
  );
  return textResult(`Your recent orders:\n${lines.join("\n")}`, { orders: summaries });
}
