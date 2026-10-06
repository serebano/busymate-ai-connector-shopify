import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { meterShop } from "../lib/usageBilling";
import { BILLING_METER_HEADER, BILLING_METER_SECRET_ENV, meterRequestAuthorized } from "../lib/meterAuth.server";

/**
 * POST /api/billing/meter — THE metering trigger. Meters every shop with an
 * active plan (`meterShop`: allowance → overage → App Events billing event) so
 * usage reaches Shopify without waiting for a merchant to open the Billing page.
 *
 * Scheduled by a host timer, e.g. systemd (secret read from the env file, never argv):
 *   ExecStart=/bin/sh -c 'curl -fsS -X POST -H "x-billing-meter-secret: $$BILLING_METER_SECRET" http://127.0.0.1:3970/api/billing/meter'
 *   EnvironmentFile=/etc/busymate-ai-shopify/env
 * (`?shop=<store>.myshopify.com` meters one shop.)
 *
 * AUTH: see app/lib/meterAuth.server.ts — fail-closed (503 when unconfigured,
 * 401 when denied), timing-safe, value-blind.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const auth = meterRequestAuthorized(request.headers.get(BILLING_METER_HEADER));
  if (auth === "unconfigured") return Response.json({ ok: false, error: `${BILLING_METER_SECRET_ENV} not configured` }, { status: 503 });
  if (auth === "denied") return new Response("unauthorized", { status: 401 });

  const only = new URL(request.url).searchParams.get("shop");
  const rows = await prisma.billingState.findMany({
    where: only ? { shop: only } : { status: "active" },
    select: { shop: true },
  });
  const results: Record<string, unknown> = {};
  for (const { shop } of rows) {
    try {
      results[shop] = await meterShop(shop);
    } catch (err) {
      results[shop] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  console.log(`[billing] meter run shops=${rows.length}`);
  return Response.json({ ok: true, shops: rows.length, results });
};

export const loader = async () => new Response("method not allowed", { status: 405 });
