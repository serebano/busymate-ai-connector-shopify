import type { LoaderFunctionArgs } from "react-router";
import { readFreshnessHealth } from "../lib/kbFreshness.server";
import { BILLING_METER_HEADER, meterRequestAuthorized } from "../lib/meterAuth.server";

/**
 * GET /api/kb/health — the knowledge-freshness health check (#52). FAIL-CLOSED:
 * 200 only when every active shop's knowledge is ≤ 96 h old AND a backstop run
 * finished within the silence limit; 503 for RED (stale shop, dead timer) and for
 * UNVERIFIED (the tenant table could not be read). An external dead-man reads it
 * (busymate-ai `v2-infra-deadman`, the `shopify-kb` arm), so a silent host or a
 * stopped timer pages too — the absence of success is the alarm.
 *
 * Public body = counts + reasons only. Per-shop detail (shop domains) only for the
 * host timer secret (`x-billing-meter-secret`, the same host-internal secret the
 * meter trigger uses); value-blind, never echoed.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const health = await readFreshnessHealth();
  const operator = meterRequestAuthorized(request.headers.get(BILLING_METER_HEADER)) === "ok";
  const { stale, ...publicHealth } = health;
  return Response.json(
    { ok: health.verdict === "green", checkedAt: new Date().toISOString(), ...publicHealth, ...(operator ? { stale } : {}) },
    { status: health.verdict === "green" ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
};
