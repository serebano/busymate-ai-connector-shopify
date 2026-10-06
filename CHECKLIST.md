# Shopify App Store / Built-for-Shopify compliance checklist

Status legend: **[x]** scaffolded (structure + seam in place) · **[~]** partial
(shape wired, real impl TODO) · **[ ]** TODO · **🔒** owner-gated.

> This app is **verified-buildable + unit-tested** (`npm run typecheck | lint |
> test | build` all green — 407 tests / 42 files) with the **Phase-1 code gaps
> closed** (real connector tools · delegation flip · billing sync + metering ·
> at-rest encryption · settings/re-ingest proof shape · API 2026-07 · honest
> listing copy + 14 locales · icon · privacy/FAQ drafts). The remaining blockers
> are all **owner-gated** (Partner app registration, pricing plans, PCD submit,
> demo store, publishing the privacy page). The exact owner steps are in **`SETUP.md`**.

## Deployment state (Phase-1)

- **App host** `shopify.busymate.ai` (busymate-v2-lon1, systemd `busymate-ai-shopify`,
  :3970) redeployed on the Phase-1 code. Live `/api/bmai/status` →
  `{ok:true, actorVerifier:true, launchIdentity:true, apiVersion:"2026-07"}`;
  MCP `tools/list` serves 12 tools; `tools/call` fails closed. Env updated:
  `SHOPIFY_API_VERSION=2026-07`, `APP_ENCRYPTION_KEY` set (mirrored to vault as
  `SHOPIFY_APP_ENCRYPTION_KEY`) so at-rest encryption is ACTIVE; `BMAI_SUPPORT_ACTOR_MASTER`
  present → the connector flips to `signed_actor_token` on the next provision.
- **Shopify Partner app** — `shopify app deploy` created version **`busymate-ai-3`**
  (`--no-release`, org "SERGIU TODERASCU, AI"): the 2026-07 config + `app_subscriptions/update`
  webhook + theme extension reached the app. Owner step: `shopify app release --version=busymate-ai-3`
  when submitting. (Deploy uploads are geo-blocked from the lon1 host, so the CLI deploy
  runs from an allowed network with the vault automation token.)

## Build & tests (provable now, no owner creds)

- [x] `npm run typecheck` clean (one `@shopify/shopify-api` 14.0.1 dependency; no `overrides`)
- [x] `npm run lint` clean (typescript-eslint parser wired into the flat config)
- [x] `npm test` — 407 passing: provisioning seam + delegation flip · proof-of-shop +
  bmai OAuth token · **real connector tools (Admin GraphQL, no TODO stubs)** · GDPR
  dispatch · billing gate + **subscription sync** + **usage metering (cap-clamped)** ·
  **field cipher (at-rest)** · **mgmt call-shape** · App-Proxy HMAC · connector
  transport/gates · actor-token verify (interop) · /api/bmai/status · tenant slug · naming
- [x] `npm run build` — clean React Router 7 SSR build
- [x] `package-lock.json` committed (CI `npm ci` works)

## Installation & auth

- [x] **Managed installation** (token exchange — the `@shopify/shopify-app-react-router` 2.x default) — `app/shopify.server.ts`
- [x] **Expiring offline access tokens** (#2110) — `future.expiringOfflineAccessTokens: true`;
  `Session.refreshToken`/`refreshTokenExpires` columns + migration `20260902120000_session_refresh_token`;
  refresh token encrypted at rest; every background Admin call goes through
  `unauthenticated.admin(shop)` (`app/mcp/shopifyAdmin.ts`) so it refreshes; pre-upgrade
  sessions cycled once by `npm run tokens:cycle` (`scripts/cycle-offline-tokens.ts`, SETUP §3c)
- [x] **`/auth/login` never 500s** — `app/routes/auth.login.tsx`: valid `?shop=` → Shopify's
  managed-install redirect, otherwise → the branded root (no manual myshopify.com form, Req 2.3.1)
- [x] **Embedded app** + App Bridge + Polaris — `app/routes/app.tsx`, `entry.server.tsx` (frame headers)
- [x] Offline access token + refresh token persisted — Prisma `Session` (`@shopify/shopify-app-session-storage-prisma` 10)
- [~] OAuth 2.1 discovery for the connector (DCR/PKCE/iss/resource) — `app/mcp/route.ts` (metadata shape; full AS is P2/P3)
- [x] **Signed actor-token delegation verified app-side** — `app/mcp/actorToken.ts` +
  `app/mcp/auth.ts` HMAC-verify Busymate AI's HS256 actor token (per-(tenant,connector)
  secret derived from a shared master; iss/aud/kid/ttl/claim pins; fail-closed).
  Interop-tested against an independent reproduction of Busymate AI's signer. `/api/bmai/status`
  probes readiness.
- [x] **Connector delegation flip is automatic in-code** — provisioning registers
  `delegation_mode:'signed_actor_token'` + the delegated write tools ONLY when the host
  can verify the actor token (`masterSecretUsable(BMAI_SUPPORT_ACTOR_MASTER)`), else it
  stays read-only `none` (no green-while-dead). **Remaining owner/deploy step:** provision
  `BMAI_SUPPORT_ACTOR_MASTER` (= Busymate AI's `V2_SUPPORT_ACTOR_TOKEN_SECRET`) into the
  deploy env; the next re-provision flips it live.

## Mandatory GDPR compliance webhooks (the #1 rejection cause)

- [x] Declared via `compliance_topics` in `shopify.app.toml`
- [x] `customers/data_request` handler — pure dispatch (`app/lib/compliance.ts`) →
  `export_tenant_customer_data` MCP call; unit-tested.
- [x] `customers/redact` handler — dispatch → `redact_tenant_customer` MCP call;
  idempotent + unit-tested.
- [x] `shop/redact` handler — full tenant teardown wired (`onShopRedact`)
- [x] HMAC verification (fail-closed) via `authenticate.webhook`; the App-Proxy HMAC
  primitive (`verifyAppProxyHmac`) is independently unit-tested
- [x] A failed compliance effect returns 500 (Shopify retries) — never silently green;
  a shop with NO provisioned tenant answers `customers/data_request` / `customers/redact`
  with a 200 no-op ("nothing held") instead of a 500 (#2110)

## Lifecycle webhooks

- [x] `app/uninstalled` → suspend tenant + purge sessions — `webhooks.app.uninstalled.tsx`
- [x] `app/scopes_update` handled — `webhooks.app.scopes_update.tsx`
- [x] `app_subscriptions/update` → BillingState sync — `webhooks.app_subscriptions.update.tsx`
- [x] Product KB-freshness webhook re-trains the tenant (debounced per shop) —
  `webhooks.kb.products.tsx` → `app/lib/ingest.ts`; order webhooks never re-train
  (orders are read live through the connector)
- [x] **Reinstall restores the assistant** — `provision_partner_tenant` reactivates the
  archived tenant (`reactivated:true`), the lifecycle re-publishes → Home "Live"
  (`test/provision.test.ts`)

## API version & scopes

- [x] `api_version = "2026-07"` pinned (toml + admin client + `/api/bmai/status`)
- [x] Least-privilege scopes declared (`read_products,read_content,read_legal_policies,read_orders,read_customers,read_fulfillments,write_orders,read_returns,write_returns`) —
  `read_legal_policies` = the store policies the assistant is trained on (`test/appConfig.test.ts` pins the training query to the scopes)
- [x] Mutation/scope names verified vs 2026-07: refunds `write_orders`/`refundCreate`,
  returns `write_returns`/`returnCreate`, `orderCancel`/`orderUpdate`, `appUsageRecordCreate`
- [ ] 🔒 `read_all_orders` (>60-day orders) — needs Shopify approval; request at review

## Billing

- [x] Shopify Billing API only (no external checkout) — Managed Pricing **check +
  redirect** wired (`app/lib/billingGate.ts` → `app.billing.tsx`); unit-tested
- [x] Usage charges **capped**; **widget never disabled at cap** — hard invariant
  `widgetEnabled() === true`, asserted by `test/billingGate.test.ts`
- [x] **Subscription status sync** — `app_subscriptions/update` webhook + the billing
  loader reconcile `currentAppInstallation.activeSubscriptions` → BillingState
  (`billingSync.ts` + `billingState.server.ts`; `test/billingSync.test.ts`)
- [x] **Usage-record metering** — `meterShop()` creates a cap-clamped `AppUsageRecord`
  (`appUsageRecordCreate`) respecting `cappedAmountCents` (`test/usageBilling.test.ts`).
  Its trigger (host cron / bmai resolution signal) is the remaining external wiring.
- [ ] 🔒 Define the Managed Pricing plans in Partners + guarantee accounting decision

## Grounded knowledge (the listing's core claim)

- [x] **Trained at install** — the lifecycle publishes the store's products / policies /
  pages as `publish_tenant_runtime.knowledge_sources` in the same publish that takes the
  tenant live (`app/lib/kbSnapshot.ts` + `kbTrain.ts` + `kbFetch.ts`; deterministic,
  within the platform limits; `test/kbSnapshot.test.ts`, `test/kbTrain.test.ts`)
- [x] **Visible training state** — Home + Store connection show "Trained on N products,
  M policies, K pages · last trained …" or the error; **Re-train on my store** runs it
  synchronously and reports the counts (`ShopTenant.kb*`, `test/prismaTrainingSchema.test.ts`)
- [x] Ingest errors are persisted + surfaced, never swallowed

## Storefront & performance

- [x] **Theme app extension** (app-embed block; no `theme.liquid` edit) — `extensions/storefront-assistant/**`
- [x] Widget loads via the platform embed (`/embed/v1.js`), deferred/async
- [ ] Performance budget — widget must not regress storefront LCP/CLS (measure at P3)
- [x] App Proxy identity path for logged-in customers — `identity.tsx` + HMAC verify;
  `[app_proxy]` declared in `shopify.app.toml` (`/apps/busymate-ai/*` → `store.busymate.ai`),
  pinned to the extension's `IDENTITY_URL` by `test/appConfig.test.ts` (needs `shopify app deploy`)
- [x] Branded 404/500 page (root `ErrorBoundary`, no framework developer hints) + real
  `/favicon.ico` and `/robots.txt` under `public/`; `npm run build` pins `NODE_ENV=production`

## Privacy & data

- [x] Dedicated app DB (independent failure domain; not the bmai control plane)
- [x] All control-plane ops via MCP (no backdoor DB writes) — `bmai.server.ts`
- [x] **Encryption at rest** for credential/PII columns (AES-256-GCM,
  `app/lib/fieldCipher.ts` + `EncryptedSessionStorage`) — makes the PCD attestation
  TRUE; retention windows in `docs/DATA-RETENTION.md`
- [x] Privacy policy + FAQ **drafted** (`docs/legal/privacy.md` + `faq.md`, app-specific)
- [x] Privacy policy + FAQ **published** at `https://store.busymate.ai/legal/privacy` +
  `https://store.busymate.ai/legal/faq` (the `privacy_url` / `faq_url` in `listing/*.json`
  and on the canonical store record)

## Listing

- [x] Localized listing — `listing/en.json` + all **14** Tier-1 locales with real translations
- [x] **Factual-accuracy copy** (Req 4.3.3): no guarantees/superlatives/competitor-flaw
  positioning; grounding = "answers only from your store content, with sources, and says
  when it is not sure"
- [x] **No pricing outside Pricing details, no numerals/statistics in the copy**
  (Req 4.2.3 / 4.3.3 / 4.4.1) — pinned for all 14 locales by `test/listing-copy.test.ts`;
  intro + details + privacy_url drift-checked against the canonical record
- [x] App **icon** (1200×1200, `listing/assets/icon-1200.png`)
- [ ] 🔒 Screenshots, feature banner, demo video (mp4/H.264), demo store + reviewer creds
- [ ] **(Optional) List in the Busymate AI directory** over MCP, once the App Store
  listing exists and is approved. See `docs/LISTING.md`.

## Owner-gated blockers (cannot be done from this session)

1. 🔒 **Create the app in the Shopify Partner Dashboard** → issues `client_id` + secret
   → `shopify app config link` writes them into `shopify.app.toml` / env.
2. 🔒 **Provisioning credential** (the provisioning-credential step): ship `provision_partner_tenant` (proof-of-shop)
   on the Busymate AI side, OR mint a scoped operator OAuth client for the app.
3. 🔒 **App-server host** (`shopify.busymate.ai`) + DNS + Let's Encrypt + systemd unit.
4. 🔒 **ES256 launch signing key** + register JWKS as the tenant visitor IdP.
5. 🔒 **Billing plan** definition in Partners + guarantee accounting decision.
6. 🔒 **Listing assets + translations** + demo store.

## Next phases (NEVER PARK — each has an active lane)

- **P2 — CODE DONE** — real Admin-API tool impls ✅ · provisioning wired to bmai MCP ✅
  · identity/JWKS ✅. Remaining: publish `@busymate/whitelabel-sdk`; live exit-check
  (store installs, widget appears, grounded FAQ/policy + WISMO reads) needs the
  owner-gated Partner app + host.
- **P3 — CODE DONE** — write connector tools (delegated+confirm+cap) ✅ · subscription
  sync + usage metering ✅ · at-rest encryption ✅. Remaining owner steps: pricing
  plans in Partners, PCD submit, demo store + reviewer creds, publish the privacy
  page, then **App Store submission**.
- **P4+** — trust engine · autonomous depth · onboarding · omnichannel · analytics/ROI
  · enterprise.
