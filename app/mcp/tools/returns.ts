import type { ToolContext, ToolResult } from "./types";
import { errorResult, textResult } from "./types";
import { findCustomerOrder } from "./orderLookup";

/**
 * Delegated + confirm WRITE tools (Admin GraphQL 2026-07). The transport enforces
 * confirm before dispatch and every write is gated on the identified customer +
 * a verified Busymate AI actor token, so these run scoped to ONE customer's own order.
 *
 * Refund cap: above `DEFAULT_REFUND_CAP_CENTS` we do NOT auto-refund — we escalate
 * to a human (request_human handoff). Merchant-configurable is a P3 follow-up.
 */
const DEFAULT_REFUND_CAP_CENTS = 5000;

const USER_ERRORS = `userErrors { field message }`;

function firstError(errors?: Array<{ message?: string }> | null): string | null {
  const msg = errors?.find((e) => e.message)?.message;
  return msg ?? null;
}

function guardCustomer(ctx: ToolContext, verb: string): ToolResult | null {
  if (!ctx.customerId) return errorResult(`Sign in required to ${verb} your order.`);
  return null;
}

function orderNotFound(orderNumber: unknown): ToolResult {
  return textResult(
    `I couldn't find order ${String(orderNumber ?? "")} on your account, so I can't act on it.`,
    { order: null },
  );
}

/** A settled SALE/CAPTURE transaction to refund against, or null. */
async function refundableParent(
  ctx: ToolContext,
  orderId: string,
): Promise<{ id: string; gateway: string } | null> {
  const data = (await ctx.admin.graphql(
    `#graphql
    query OrderTransactions($id: ID!) {
      order(id: $id) {
        transactions(first: 20) { id kind status gateway }
      }
    }`,
    { id: orderId },
  )) as { order?: { transactions?: Array<{ id: string; kind: string; status: string; gateway: string }> } };
  const txs = data.order?.transactions ?? [];
  const parent = txs.find(
    (t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS",
  );
  return parent ? { id: parent.id, gateway: parent.gateway } : null;
}

export async function createRefund(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const guard = guardCustomer(ctx, "request a refund on");
  if (guard) return guard;

  const amountCents = Number(args.amount_cents ?? 0);
  const cap = DEFAULT_REFUND_CAP_CENTS;
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return errorResult("Tell me the refund amount and I'll take a look.");
  }
  if (amountCents > cap) {
    // Above cap → do NOT auto-refund; hand off to a human (request_human is LIVE).
    return errorResult(
      `This $${(amountCents / 100).toFixed(2)} refund is above the automatic limit. I'll connect you with the team to approve it.`,
    );
  }

  const order = await findCustomerOrder(ctx, args.order_number);
  if (!order) return orderNotFound(args.order_number);

  const parent = await refundableParent(ctx, order.id);
  if (!parent) {
    return errorResult(
      `I can't process an automatic refund on ${order.name} (no settled payment to refund against). I'll pass this to the team.`,
    );
  }

  const amount = (amountCents / 100).toFixed(2);
  const data = (await ctx.admin.graphql(
    `#graphql
    mutation RefundCreate($input: RefundInput!) {
      refundCreate(input: $input) {
        refund { id totalRefundedSet { presentmentMoney { amount currencyCode } } }
        ${USER_ERRORS}
      }
    }`,
    {
      input: {
        orderId: order.id,
        note: String(args.reason ?? "Customer refund via Busymate AI"),
        notify: true,
        transactions: [
          { orderId: order.id, gateway: parent.gateway, kind: "REFUND", amount, parentId: parent.id },
        ],
      },
    },
  )) as {
    refundCreate?: {
      refund?: { id: string; totalRefundedSet?: { presentmentMoney?: { amount: string; currencyCode: string } } } | null;
      userErrors?: Array<{ message?: string }>;
    };
  };

  const err = firstError(data.refundCreate?.userErrors);
  if (err || !data.refundCreate?.refund) {
    return errorResult(`I couldn't complete that refund: ${err ?? "no refund was created"}.`);
  }
  const refunded = data.refundCreate.refund.totalRefundedSet?.presentmentMoney;
  return textResult(
    `Refunded ${refunded ? `${refunded.amount} ${refunded.currencyCode}` : `$${amount}`} on ${order.name}. It can take a few business days to appear.`,
    { order: order.name, refundId: data.refundCreate.refund.id, amount },
  );
}

function orderReason(input: unknown): string {
  const allowed = new Set(["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"]);
  const r = String(input ?? "").toUpperCase();
  return allowed.has(r) ? r : "CUSTOMER";
}

export async function cancelOrder(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const guard = guardCustomer(ctx, "cancel");
  if (guard) return guard;
  const order = await findCustomerOrder(ctx, args.order_number);
  if (!order) return orderNotFound(args.order_number);
  if (order.cancelledAt) {
    return textResult(`${order.name} is already cancelled.`, { order: order.name, cancelled: true });
  }
  if (order.displayFulfillmentStatus === "FULFILLED") {
    return errorResult(
      `${order.name} has already shipped, so I can't cancel it — but I can help you start a return instead.`,
    );
  }

  const data = (await ctx.admin.graphql(
    `#graphql
    mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean) {
      orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer) {
        job { id }
        orderCancelUserErrors { field message }
      }
    }`,
    {
      orderId: order.id,
      reason: orderReason(args.reason),
      refund: true,
      restock: true,
      notifyCustomer: true,
    },
  )) as {
    orderCancel?: { job?: { id: string } | null; orderCancelUserErrors?: Array<{ message?: string }> };
  };

  const err = firstError(data.orderCancel?.orderCancelUserErrors);
  if (err) return errorResult(`I couldn't cancel ${order.name}: ${err}.`);
  return textResult(
    `Cancelled ${order.name} and started your refund. You'll get a confirmation email shortly.`,
    { order: order.name, jobId: data.orderCancel?.job?.id ?? null },
  );
}

const ADDRESS_FIELDS = [
  "address1",
  "address2",
  "city",
  "company",
  "country",
  "countryCode",
  "firstName",
  "lastName",
  "phone",
  "province",
  "provinceCode",
  "zip",
] as const;

function mailingAddressInput(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ADDRESS_FIELDS) {
    if (src[k] != null && src[k] !== "") out[k] = src[k];
  }
  return Object.keys(out).length ? out : null;
}

export async function updateShippingAddress(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const guard = guardCustomer(ctx, "update the shipping address on");
  if (guard) return guard;
  const order = await findCustomerOrder(ctx, args.order_number);
  if (!order) return orderNotFound(args.order_number);
  if (order.displayFulfillmentStatus === "FULFILLED") {
    return errorResult(`${order.name} has already shipped, so its address can no longer be changed.`);
  }

  const shippingAddress = mailingAddressInput(args.address);
  if (!shippingAddress) {
    return errorResult("Give me the new shipping address (street, city, postal code, country) and I'll update it.");
  }

  const data = (await ctx.admin.graphql(
    `#graphql
    mutation OrderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        ${USER_ERRORS}
      }
    }`,
    { input: { id: order.id, shippingAddress } },
  )) as { orderUpdate?: { order?: { id: string } | null; userErrors?: Array<{ message?: string }> } };

  const err = firstError(data.orderUpdate?.userErrors);
  if (err || !data.orderUpdate?.order) {
    return errorResult(`I couldn't update the address on ${order.name}: ${err ?? "the update was rejected"}.`);
  }
  return textResult(`Updated the shipping address on ${order.name}.`, {
    order: order.name,
    updated: Object.keys(shippingAddress),
  });
}

export { DEFAULT_REFUND_CAP_CENTS };
