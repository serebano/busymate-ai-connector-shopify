/**
 * Shopify App Events API client — how usage is METERED under Shopify App Pricing.
 * A billing event `{ event_handle: "ai_resolution", attributes: { value: N } }`
 * per batch of billable resolutions; Shopify aggregates it against the usage
 * meter of the merchant's plan (Partner Dashboard → Pricing → usage charges,
 * event handle `ai_resolution`) and adds the charge to the monthly bill.
 * Docs: https://shopify.dev/docs/api/app-events ·
 *       https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges
 *
 * AUTH: a Dev Dashboard API key (client id + secret) exchanged for a 60-min JWT
 * via client_credentials. VALUE-BLIND: read from env by NAME, never logged.
 * FAIL-CLOSED: no credential ⇒ ok:false naming the env vars, never a fake 202.
 *
 * Note: the API answers 202 for any well-formed event; billing validation
 * errors (NO_SUBSCRIPTION, PERIOD_CLOSED, …) surface only in the Dev Dashboard
 * → Logs → App Billing Event. Idempotency is permanent for billing events: a
 * repeated key gets the ORIGINAL response back with `Idempotent-Replay: true`
 * (the new payload is not applied). The meter keys each event by (shop, billing
 * cycle, units already reported) — `cumulativeUsageKey` — so a retry after a lost
 * reply can never add the same units twice, and treats a replay as "held".
 */
import { createHash } from "node:crypto";

export const APP_EVENTS_API_VERSION = "2026-07";
export const APP_EVENTS_URL = `https://api.shopify.com/app/${APP_EVENTS_API_VERSION}/events`;
export const APP_EVENTS_TOKEN_URL = "https://api.shopify.com/auth/access_token";
/** The usage-meter event handle configured on every paid plan. */
export const RESOLUTION_EVENT_HANDLE = "ai_resolution";

export const APP_EVENTS_CLIENT_ID_ENV = "SHOPIFY_APP_EVENTS_CLIENT_ID";
export const APP_EVENTS_CLIENT_SECRET_ENV = "SHOPIFY_APP_EVENTS_CLIENT_SECRET";

export interface AppEventsConfig {
  clientId: string;
  /** Non-enumerable accessor so the secret never serializes. */
  readonly secret: () => string;
}

/** Read the Dev-Dashboard client credential (value-blind); null when absent or EMPTY. */
export function readAppEventsConfig(env: NodeJS.ProcessEnv = process.env): AppEventsConfig | null {
  const clientId = (env[APP_EVENTS_CLIENT_ID_ENV] ?? "").trim();
  const secret = (env[APP_EVENTS_CLIENT_SECRET_ENV] ?? "").trim();
  if (!clientId || !secret) return null;
  const cfg = { clientId } as AppEventsConfig;
  Object.defineProperty(cfg, "secret", { value: () => secret, enumerable: false });
  return cfg;
}

/** ≤64-char, stable per (shop, cursor) — a distinct key per distinct charge. */
export function usageIdempotencyKey(shop: string, cursor: string): string {
  const digest = createHash("sha256").update(`${shop}\n${cursor}`, "utf8").digest("hex").slice(0, 40);
  return `bmai_res_${digest}`; // 9 + 40 = 49 chars
}

/**
 * The billing-event key for "units reported to Shopify in `cycleKey` so far = `reportedBefore`".
 * One key per position in the cycle's cumulative count: the retry of a send whose reply was
 * lost reuses it (Shopify replays the original, never adds units twice), and the next batch
 * after a recorded success gets a new one. ≤64 chars.
 */
export function cumulativeUsageKey(shop: string, cycleKey: string, reportedBefore: number): string {
  const digest = createHash("sha256").update(`${shop}\n${cycleKey}\n${reportedBefore}`, "utf8").digest("hex").slice(0, 40);
  return `bmai_cum_${digest}`; // 9 + 40 = 49 chars
}

export interface ReportUsageInput {
  /** `gid://shopify/Shop/…` or the numeric id as a string. */
  shopId: string;
  units: number;
  idempotencyKey: string;
  /** ISO-8601, within the current billing cycle and ≤5 min in the future. */
  timestamp: string;
}

/**
 * `replay`: Shopify answered with `Idempotent-Replay: true` — an earlier event with this key was
 * already received (a reply we lost). Its units are unknown here, so the caller holds the batch
 * until Shopify's reported quantity shows them (usageBilling.meterShop reconciles first).
 */
export type ReportResult = { ok: true } | { ok: false; error: string; replay?: boolean };

export interface AppEventsClient {
  reportUsage(input: ReportUsageInput): Promise<ReportResult>;
}

export interface AppEventsDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Clock (ms) for the token cache — injectable for tests. */
  now?: () => number;
}

/** Build a client with a cached client-credentials token (re-minted 60 s early). */
export function createAppEventsClient(deps: AppEventsDeps = {}): AppEventsClient {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(cfg: AppEventsConfig): Promise<string> {
    if (cached && cached.expiresAt > now()) return cached.token;
    const res = await doFetch(APP_EVENTS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.secret(), grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`App Events token ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("App Events token response had no access_token");
    const ttlMs = Math.max(0, (Number(json.expires_in ?? 3600) - 60) * 1000);
    cached = { token: json.access_token, expiresAt: now() + ttlMs };
    return cached.token;
  }

  return {
    async reportUsage(input) {
      const cfg = readAppEventsConfig(env);
      if (!cfg) {
        return { ok: false, error: `App Events credential missing (${APP_EVENTS_CLIENT_ID_ENV}/${APP_EVENTS_CLIENT_SECRET_ENV}) — usage not reported` };
      }
      const units = input.units;
      if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, error: "units must be a positive integer (Shopify rejects value=0)" };
      try {
        const bearer = await token(cfg);
        const res = await doFetch(APP_EVENTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
          body: JSON.stringify({
            shop_id: input.shopId,
            event_handle: RESOLUTION_EVENT_HANDLE,
            timestamp: input.timestamp,
            idempotency_key: input.idempotencyKey,
            attributes: { value: units },
          }),
        });
        if (res.status === 401) cached = null; // force a re-mint next time
        if (res.ok && /^true$/i.test(res.headers.get("Idempotent-Replay") ?? "")) {
          return { ok: false, replay: true, error: "App Events replayed an earlier event with this key — held until Shopify's usage quantity shows it" };
        }
        const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!res.ok || body.success === false) {
          return { ok: false, error: `App Events ${res.status}: ${body.error ?? "rejected"}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
