import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { BILLING_METER_HEADER, meterRequestAuthorized } from "../lib/meterAuth.server";

/**
 * GET /api/billing/health — usage-metering alerts (docs/BILLING.md "Holds and alerts").
 * FAIL-CLOSED: 200 only when no installed shop has an open usage-meter alert (a replay hold
 * longer than 2 runs, a Shopify server error that must not be resent, a reconciliation stop,
 * or our reported units disagreeing with Shopify's meter for more than 2 runs); 503 otherwise,
 * and 503 when the table cannot be read. Built for the same external dead-man as /api/kb/health.
 *
 * Public body = counts only. Shop domains + alert text only for the host meter secret.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const operator = meterRequestAuthorized(request.headers.get(BILLING_METER_HEADER)) === "ok";
  try {
    const open = await prisma.billingState.findMany({
      where: { meterAlert: { not: null }, tenant: { inactiveAt: null } },
      select: { shop: true, meterAlert: true, meterAlertAt: true },
    });
    const ok = open.length === 0;
    return Response.json(
      { ok, checkedAt: new Date().toISOString(), openAlerts: open.length, ...(operator ? { alerts: open } : {}) },
      { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ ok: false, checkedAt: new Date().toISOString(), error: "billing state unreadable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
};
