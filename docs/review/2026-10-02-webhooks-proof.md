# Webhook compliance + expiring-offline-token proof — 2026-10-02

Owner order 2026-10-02 "make the Shopify connector 100% ready", item d
(busymate-devtools#3995). App **0.1.15** (`fix/shopify-100-ready`, `6c63b44`). Host
`busymate-v2-lon1` (`/opt/busymate-ai-shopify`, unit `busymate-ai-shopify` on `127.0.0.1:3970`).
Every host command below ran with the root-only env file sourced into the environment
(`sudo bash -c 'set -a; . /etc/busymate-ai-shopify/env; set +a; …'`) and printed status only —
no token, HMAC, secret or connection string appears here or in the host output. All times UTC.

**Nothing was deployed.** The live unit stayed at `a58ae33` (0.1.14), `active`, 0 restarts,
throughout. The 0.1.15 proof ran on a SIDE server (same host, same DB, port 3971) built from this
branch in a throw-away checkout that was removed afterwards (see "How the side server ran").

## 1. Why webhooks could answer 500 — and the behaviour chosen

`authenticate.webhook` (`@shopify/shopify-app-react-router` 2.1.0) verifies the HMAC, then calls
`ensureValidOfflineSession`: it loads the shop's offline session and, with
`future.expiringOfflineAccessTokens`, REFRESHES it when it is within 5 min of expiry
(`ensureOfflineTokenIsNotExpired` → `refreshToken` → `api.auth.refreshToken`). After an uninstall,
or for any shop whose refresh token Shopify no longer honours, that refresh fails and the library
throws `Response 500` (or re-throws `InvalidJwtError` / `invalid_subject_token`, which React Router
also renders as 500). Shopify retries a failing delivery, then **deletes the subscription after 8
failures** — so a dead session silently turned off `domains/*`, `app_subscriptions/update`,
`app/scopes_update` and the KB webhooks for that shop, and inflated the Dev Dashboard failure rate
(51.4 % on 2026-09-25 before 0.1.13 moved `app/uninstalled` + the GDPR topics off that path).

**Decision (0.1.15):** every webhook route verifies the HMAC FIRST with the session-free
`authenticateWebhookWithoutSession` (`app/lib/webhookAuth.ts`: POST, HMAC over the raw body in
constant time, required headers, JSON body — 405 / 401 / 400 exactly where the library answers
them) and acks 200 at once. No handler needs the session at delivery time:

| Route | Delivery-time work | Admin-API work | How it gets a token |
|---|---|---|---|
| `webhooks.compliance.tsx` (3 GDPR topics) | export / redact / teardown via the Busymate AI MCP + app DB | none | — |
| `webhooks.app.uninstalled.tsx` | suspend the tenant, purge sessions | none | — |
| `webhooks.app_subscriptions.update.tsx` | `syncBillingState` (app DB upsert) | none | — |
| `webhooks.app.scopes_update.tsx` | write the new scope set onto the offline session ROW by its deterministic id `offline_<shop>` (`offlineSessionId`, `updateMany` → a missing row is a no-op) | the queued re-train | background, `adminForShop` → `unauthenticated.admin(shop)` (refreshes itself; an unrefreshable token is a persisted `kbError`, never a webhook status) |
| `webhooks.domains.tsx` (3 topics) | log | `refreshStorefrontDomains` (read the store's domains, repair the allowlist) | background, `adminForShop`; wrapped in try/catch, gated per shop, never throws |
| `webhooks.kb.products.tsx`, `webhooks.kb.orders.tsx` | `scheduleReingest` (debounced; orders never re-train) | the queued re-train | background, as above |

Pinned by `test/webhookAuth.test.ts` (the route list is DERIVED from `app/routes/webhooks.*.tsx`: no
route may call `authenticate.webhook` or import the session-resolving exports of the app module) and
`test/webhookRoutes.test.ts` (every route's real action, HMAC-signed deliveries while the session
store THROWS on any read: 200 per topic, 401 on a bad HMAC, no effect on a bad HMAC, the session
store never read; the delivery table must cover every route file). `test/tenantRepair.test.ts`
pins the domains route to the session-free path. Full suite: 73 files / 705 tests green.

## 2. The live probe — `scripts/webhook-probe.ts` (`npm run webhooks:probe`)

Seeds the app DB with a synthetic `ShopTenant` row (`provisionState: pending`, no platform tenant —
nothing is held, nothing reaches Busymate AI) and an **EXPIRED offline `Session`** for
`probe-expired-<ts>.myshopify.com` (token expired 1 h earlier, a refresh token Shopify will not
honour; written through the app's own encrypting session storage). For every topic in
`shopify.app.toml` it re-seeds the expired session (an uninstall purges it), POSTs a Shopify-shaped
payload signed with `SHOPIFY_API_SECRET` (expects **200**), then the same body with a bad HMAC
(expects **401**), then deletes the synthetic rows and reports `synthetic rows left = 0`.

### 2a. Baseline — the LIVE unit, 0.1.14 (`a58ae33`), 12:28:44 UTC

| Topic | Route | Session before | Signed → status (ms) | Bad HMAC → status (ms) | Session after | Result |
|---|---|---|---|---|---|---|
| `customers/data_request` | `/webhooks/compliance` | expired | **200** (84 ms, 12:28:44.838Z) | **401** (9 ms) | expired | pass |
| `customers/redact` | `/webhooks/compliance` | expired | **200** (12 ms, 12:28:44.941Z) | **401** (9 ms) | expired | pass |
| `app/scopes_update` | `/webhooks/app/scopes_update` | expired | **500** (234 ms, 12:28:44.974Z) | **401** (8 ms) | expired | FAIL |
| `app_subscriptions/update` | `/webhooks/app_subscriptions/update` | expired | **500** (209 ms, 12:28:45.224Z) | **401** (9 ms) | expired | FAIL |
| `domains/create` | `/webhooks/domains` | expired | **500** (238 ms, 12:28:45.450Z) | **401** (9 ms) | expired | FAIL |
| `domains/update` | `/webhooks/domains` | expired | **500** (202 ms, 12:28:45.705Z) | **401** (8 ms) | expired | FAIL |
| `domains/destroy` | `/webhooks/domains` | expired | **500** (197 ms, 12:28:45.923Z) | **401** (5 ms) | expired | FAIL |
| `products/update` | `/webhooks/kb/products` | expired | **500** (196 ms, 12:28:46.131Z) | **401** (13 ms) | expired | FAIL |
| `app/uninstalled` | `/webhooks/app/uninstalled` | expired | **200** (16 ms, 12:28:46.348Z) | **401** (5 ms) | missing | pass |
| `shop/redact` | `/webhooks/compliance` | expired | **200** (17 ms, 12:28:46.377Z) | **401** (6 ms) | missing | pass |

`passed: 4 / 10` — the four routes 0.1.13 made session-free pass; the six still on
`authenticate.webhook` answer **500** in ~200 ms (the failed refresh round-trip to Shopify). Cleanup:
`synthetic rows left = 0` (12:28:46.416Z). These six 500s are the only webhook 500s in the host
journal today (`journalctl … | grep webhooks/ | grep " 500 "` by day: 18 on 2026-09-24, the
pre-0.1.13 class; 6 on 2026-10-02, this probe). They were local deliveries to `127.0.0.1` and are
not visible to Shopify or the Dev Dashboard.

### 2b. The fix — side server running 0.1.15 (`6c63b44`) on `127.0.0.1:3971`, 12:43:15 UTC

| Topic | Route | Session before | Signed → status (ms) | Bad HMAC → status (ms) | Session after | Result |
|---|---|---|---|---|---|---|
| `customers/data_request` | `/webhooks/compliance` | expired | **200** (56 ms, 12:43:15.496Z) | **401** (17 ms) | expired | pass |
| `customers/redact` | `/webhooks/compliance` | expired | **200** (11 ms, 12:43:15.579Z) | **401** (11 ms) | expired | pass |
| `app/scopes_update` | `/webhooks/app/scopes_update` | expired | **200** (24 ms, 12:43:15.613Z) | **401** (12 ms) | expired | pass |
| `app_subscriptions/update` | `/webhooks/app_subscriptions/update` | expired | **200** (24 ms, 12:43:15.661Z) | **401** (12 ms) | expired | pass |
| `domains/create` | `/webhooks/domains` | expired | **200** (7 ms, 12:43:15.708Z) | **401** (10 ms) | expired | pass |
| `domains/update` | `/webhooks/domains` | expired | **200** (9 ms, 12:43:15.733Z) | **401** (5 ms) | expired | pass |
| `domains/destroy` | `/webhooks/domains` | expired | **200** (8 ms, 12:43:15.754Z) | **401** (6 ms) | expired | pass |
| `products/update` | `/webhooks/kb/products` | expired | **200** (6 ms, 12:43:15.778Z) | **401** (5 ms) | expired | pass |
| `app/uninstalled` | `/webhooks/app/uninstalled` | expired | **200** (16 ms, 12:43:15.794Z) | **401** (3 ms) | missing | pass |
| `shop/redact` | `/webhooks/compliance` | expired | **200** (14 ms, 12:43:15.820Z) | **401** (4 ms) | missing | pass |

`passed: 10 / 10`, every signed delivery acked in ≤ 56 ms, cleanup `synthetic rows left = 0`
(12:43:15.852Z). The side server's own log shows each handler did its work after the ack:

```
[gdpr] export noop shop=probe-expired-….myshopify.com customer=42 (nothing held)
[gdpr] redact_customer noop shop=probe-expired-….myshopify.com customer=42 (nothing held)
[scopes] probe-expired-….myshopify.com: read_products,read_legal_policies (session updated) → re-train queued
[billing] APP_SUBSCRIPTIONS_UPDATE shop=probe-expired-….myshopify.com status=cancelled synced=true
[domains] probe-expired-….myshopify.com: DOMAINS_CREATE → refreshing storefront domains
[domains] probe-expired-….myshopify.com: DOMAINS_UPDATE → refreshing storefront domains
[domains] probe-expired-….myshopify.com: DOMAINS_DESTROY → refreshing storefront domains
[kb] PRODUCTS_UPDATE for probe-expired-….myshopify.com → re-train queued
Received APP_UNINSTALLED for probe-expired-….myshopify.com
[gdpr] redact_shop ok shop=probe-expired-….myshopify.com customer=-
```

### How the side server ran (not a deploy)

As root on the host: `git clone /opt/busymate-ai-shopify /home/deploy/probe-0115` (as `deploy`),
fetch + checkout `origin/fix/shopify-100-ready` (`6c63b44`), `npm ci`, `npx prisma generate`,
`npm run build` (12:29:42 → 12:33:29), then `PORT=3971 npm start` with the env sourced, in its own
session; `/api/bmai/status` answered 200 at 12:43:13; the probe ran from that checkout against
`--base http://127.0.0.1:3971`; the server was stopped and the checkout removed (`port 3971
listeners: 0; checkout removed: yes`). The live unit: `active`, `NRestarts=0`, HEAD `a58ae33` before
and after. **After the release captain deploys 0.1.15 (SETUP §3b), re-run
`npm run webhooks:probe` against the live unit — expected 10 / 10.**

## 3. Expiring-offline-token audit (SETUP §3c)

### In code — every Admin API path refreshes through the library

- `app/shopify.server.ts`: `future.expiringOfflineAccessTokens: true`, `distribution: AppStore`,
  API version `2026-07`; sessions in Prisma behind `encryptedSessionStorage` (token + refresh token
  encrypted at rest).
- Embedded routes (`app/routes/app*.tsx`, `app/routes/auth.$.tsx`) authenticate with
  `authenticate.admin(request)` — the library's token exchange + in-request refresh.
- Every background Admin GraphQL call goes through ONE client, `adminForShop` in
  `app/mcp/shopifyAdmin.ts` → `unauthenticated.admin(shop)`, which loads the offline session and
  refreshes it within 5 min of expiry on EVERY call: connector tools (`app/mcp/tools/*`,
  `app/mcp/route.ts`), training (`app/lib/kbFetch.ts`, `app/lib/ingest.ts`), storefront domains
  (`app/lib/storefrontDomains.ts`, `app/bmai.server.ts::refreshStorefrontDomains`), usage metering
  (`app/lib/usageBilling.ts`), the reconcile sweep (`scripts/reconcile-tenants.ts`).
- No code reads `session.accessToken` or sends `X-Shopify-Access-Token` for the Admin API. The one
  `X-Shopify-Access-Token` header in the repo is the **Partner API** client token
  (`app/lib/partnerApi.ts`, Active-Subscription read) — a Partner credential, not an Admin offline
  token, and outside the expiring-token rule.
- Webhooks never load a session at all (section 1). Pre-upgrade permanent tokens were cycled once
  with `npm run tokens:cycle` on 2026-09-02 (SETUP §3c).

### On the host — read-only, value-blind counts (`npm run tokens:audit`, new in 0.1.15)

`scripts/offline-token-audit.ts`, 12:28:41 UTC, against the app DB through Prisma:

```json
{
  "sessions": { "total": 13, "offline": 13, "online": 0 },
  "offline": {
    "permanent": 0,
    "noRefreshToken": 0,
    "expiredNow": 12,
    "refreshTokenExpired": 0,
    "expiresMin": "2026-09-02T22:30:33.750Z",
    "expiresMax": "2026-10-02T13:03:14.824Z"
  },
  "verdict": "every offline session is an expiring token"
}
```

Cross-checked with `psql` (read-only, the query parameters stripped from the URL) at 12:40:31 UTC:
`permanent_offline = 0`, `offline_total = 13`, `no_refresh_token = 0`, `refresh_expired = 0`,
`online = 0`. **`isOnline = false AND expires IS NULL` → 0**, so `tokens:cycle` did not need to run.

`expiredNow = 12` is expected, not a defect: an expiring token lives ~1 h and the library refreshes
it lazily — on the next embedded request or `unauthenticated.admin(shop)` call — so a store that
has not been opened or re-trained in the last hour holds an expired access token next to a valid
refresh token (`refreshTokenExpired = 0`). The one non-expired session is the store opened in the
last hour (`expiresMax` 13:03 UTC).

Host journal, last 30 days, counts only: `Non-expiring access tokens` 0 · `Deprecated offline token`
0 · `invalid_subject_token` 0 · `SessionNotFoundError` / `no offline token for` 0 · raw `id_token`
values (7 d) 0.

### What the Dev Dashboard "API health" could still flag

1. **Webhook failure rate** (7-day window): the 2026-09-24 500s have aged out; the 6 baseline 500s
   today were local and invisible to Shopify. After 0.1.15 is deployed, nothing in this app can answer
   5xx to a webhook because of a session — only a real DB outage would (correctly retried).
2. **"Deprecated offline token use detected"** (trailing 30 days): the last permanent-token call was
   before the 2026-09-02 cycle, so the warning has cleared; 0 permanent sessions remain. It would
   return only if a pre-upgrade build were redeployed.
3. **API version**: `2026-07` is current for the Admin and Partner APIs; the next deprecation notice
   would be for the version after it.
4. **Subscriptions not active until a new app version is released**: `domains/create|update|destroy`
   are in `shopify.app.toml` but take effect only on `shopify app deploy` (owner decision in
   `2026-10-resubmission-5.1.2.md`). Until then the Dev Dashboard lists no deliveries for them
   (not a failure).
5. **`orders/*` / `fulfillments/*` webhooks** stay commented out until Protected Customer Data access
   is approved — subscribing earlier would be refused by Shopify, which the dashboard would show.
6. **Access-scope drift**: the host `SCOPES` env must equal the `shopify.app.toml` scope list (incl.
   `read_legal_policies`); a mismatch shows as `app/scopes_update` churn — the webhook now records
   the granted set without touching the session.
7. **GraphQL cost / 429s**: the KB snapshot is bounded (≤ 40 sources, ≤ 40,000 chars) and re-trains
   are debounced 20 s per shop; no throttling has been logged.
