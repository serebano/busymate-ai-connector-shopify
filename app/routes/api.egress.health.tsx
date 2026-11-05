import { readEgressHealth } from "../lib/egressAllowlist";

/**
 * GET /api/egress/health — is this host's live egress IP inside the Shopify Admin API
 * IP allowlist we keep in config/admin-api-egress-allowlist.json (= the Dev Dashboard
 * list)? 200 only when green; 503 for red (egress outside the list) and unverified
 * (echo services unreachable/disagreeing). Every Admin API caller (app, re-ingest
 * worker, kb-freshness + meter crons) is pinned to the same node, so this pod's egress
 * is theirs. Read by busymate-ai-infra review-surface-probe (shopify/admin-api-egress)
 * → ReviewSurfaceDown. Public body: addresses of our own egress only, no secrets.
 */
export const loader = async () => {
  const health = await readEgressHealth();
  return Response.json(
    { ok: health.verdict === "green", ...health },
    { status: health.verdict === "green" ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
};
