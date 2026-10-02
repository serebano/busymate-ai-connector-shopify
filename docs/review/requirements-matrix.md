# Shopify App Store requirements matrix — Busymate AI (app 0.1.15)

Started 2026-10-02 (owner order "make the Shopify connector 100% ready", busymate-devtools#3995).
Every numbered requirement from
<https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements> (fetched 2026-10-02),
plus the mandatory webhooks and protected-customer-data items the review checks alongside them.

**Status** values: `pass` (the code / a committed test / a recorded live run proves it) · `fail` ·
`n/a` (the requirement does not apply to this app) · `needs-live-evidence` (only a live run or the
Partner / Dev Dashboard can prove it — being collected by the owner; the Evidence column says what to
capture). Paths are relative to this repo unless they name a dashboard.

Companion documents: [`2026-10-resubmission-5.1.2.md`](2026-10-resubmission-5.1.2.md) (the 5.1.2 live
acceptance run, 2026-09-25), [`2026-10-02-audit.md`](2026-10-02-audit.md) (why 5.1.2 was rejected
twice), [`2026-10-02-webhooks-proof.md`](2026-10-02-webhooks-proof.md) (webhook + expiring-token proof),
[`testing-instructions.md`](testing-instructions.md) (the Partner submission text).

## 1 — Policy

### 1.1 Build and operate within Shopify's platform

| Requirement | Status | Evidence |
|---|---|---|
| 1.1.1 Use session tokens for authentication (works without third-party cookies / local storage, incognito) | pass | App Bridge session tokens + token exchange: `app/shopify.server.ts` (`@shopify/shopify-app-react-router` 2.1.0, `distribution: AppStore`, managed install); server-side sessions in Prisma, encrypted at rest (`app/lib/encryptedSessionStorage.ts`, `test/encryptedSessionStorage.test.ts`); no cookie or localStorage auth anywhere (`grep -r localStorage app/` → none). Incognito walk-through: `2026-10-resubmission-5.1.2.md` step 4 (anonymous context) |
| 1.1.2 Use Shopify checkout | n/a | the app sells nothing and touches no checkout; the connector's `draftOrderCreate` hands the shopper a Shopify checkout URL (`app/mcp/tools/orders.ts`) |
| 1.1.3 Direct merchants to the Shopify Theme Store | n/a | no theme distribution |
| 1.1.4 Use only factual information | pass | listing copy drift-checked against the canonical store record, ×14 locales: `test/listing-copy.test.ts`, `test/listing-drift.test.ts`, `scripts/lib/listing-drift.mjs`; no statistics or superlatives (`listing/`) |
| 1.1.5 Create unique apps | pass | one app, one Partner app id (416416825345); no sibling listing |
| 1.1.6 Build single-merchant storefronts | n/a | not a marketplace |
| 1.1.7 Payment Gateway apps use the Payments API | n/a | not a payments app |
| 1.1.8 Build apps for Shopify POS only | n/a | `[pos] embedded = false` (`shopify.app.toml`); no external POS |
| 1.1.9 Explicit buyer consent before adding charges | n/a | the app adds no buyer charges |
| 1.1.10 Keep the cheapest shipping option as default | n/a | no shipping logic |
| 1.1.11 Browser extensions optional only | n/a | none |
| 1.1.12 Build web-based apps | pass | embedded React Router app at `https://store.busymate.ai`; no desktop component |
| 1.1.13 Duplicate only authorized product information | pass | the assistant is trained only on the installing store's own products / policies / pages read through its Admin API (`app/lib/kbFetch.ts`, `app/lib/kbSnapshot.ts`) |
| 1.1.14 Don't connect merchants to external agencies | n/a | no brokerage |
| 1.1.15 Refunds only through the original payment processor | pass | `refundCreate` via the Admin GraphQL API (`app/mcp/tools/returns.ts`), confirm-gated + `adminOnly` + refund cap (`test/tools.test.ts`) |
| 1.1.16 Don't provide capital lending | n/a | none |

### 1.2 Bill through the Shopify Billing API or Shopify App Pricing

| Requirement | Status | Evidence |
|---|---|---|
| 1.2.1 Use Shopify App Pricing or the Billing API | pass | Shopify App Pricing (enabled 2026-09-02): Billing → Shopify's hosted plan page (`app/routes/app.billing.tsx`, `app/lib/plans.ts`, `app/lib/partnerApi.ts`); no off-platform billing. Live: "Billing → hosted plan page renders Free / Starter / Growth / Scale — no 404" (`2026-10-02-audit.md`, live re-run) |
| 1.2.2 Implement it correctly (accept / decline / reinstall) | pass | `app_subscriptions/update` sync (`app/routes/webhooks.app_subscriptions.update.tsx`, `app/lib/billingSync.ts`, `test/billingSync.test.ts`); access resolved from the real subscription (`app/lib/billingGate.ts`, `test/billingGate.test.ts`); reinstall re-reads it (`app/lib/partnerApi.ts`). Since 0.1.15 the webhook is acked 200 even when the shop's token is dead (`2026-10-02-webhooks-proof.md`) |
| 1.2.3 Allow pricing plan changes without support | pass | Billing page → change plan in-app through the hosted pricing page (`app/routes/app.billing.tsx`); plans cycled Growth → Scale → Free by the 2026-09-11 reviewer (`2026-10-02-audit.md`) |

### 1.3 Honest and transparent review practices

| Requirement | Status | Evidence |
|---|---|---|
| 1.3.1 Do not offer incentives for reviews | pass | no review prompt anywhere in the app or the extension (`grep -ri "review" app/routes extensions/storefront-assistant` → none user-facing) |

## 2 — Functionality

### 2.1 Reliable and user-friendly apps

| Requirement | Status | Evidence |
|---|---|---|
| 2.1.1 No critical errors | pass (code) / needs-live-evidence (reviewer path) | `afterAuth` never throws (`app/bmai.server.ts::onAfterAuth`, `test/provision.test.ts`); every `app.*` route has an in-frame `ErrorBoundary` + fail-closed `clientAction` (`test/clientAction.test.ts`, `test/appRouteError.test.ts`, `test/routeError.test.ts`); Home never shows a stale state (0.1.14 hold + 0.1.15 re-check, `test/homeActivation.test.ts`). **Live:** the fresh-install + uninstall/reinstall walk-through of `2026-10-resubmission-5.1.2.md` steps 3–8 on a brand-new dev store with 0.1.15 deployed |
| 2.1.2 No minor errors | pass (code) / needs-live-evidence | same as 2.1.1; the reinstall stale badge found 2026-10-02 is fixed in 0.1.15 (`CHANGELOG.md`) — re-check on a reinstall after deploy |
| 2.1.3 A UI merchants can interact with | pass | embedded Polaris routes `app/routes/app.*.tsx` (Home, Store connection, Conversations, Billing, Settings) |
| 2.1.4 Synchronize data accurately | pass | training state persisted and shown (`ShopTenant.kb*`, Home); billing synced by webhook (1.2.2); domains repaired by webhook / afterAuth / reconcile (`app/lib/tenantRepair.ts`, `test/tenantRepair.test.ts`, `test/reconcile.test.ts`) |

### 2.2 Shopify APIs and platform tools

| Requirement | Status | Evidence |
|---|---|---|
| 2.2.1 Use Shopify APIs | pass | Admin GraphQL for training, orders, products, domains (`app/mcp/tools/*`, `app/lib/kbFetch.ts`, `app/lib/tenantRepair.ts`) |
| 2.2.2 Consistent embedded experience | pass | every merchant feature is inside the embedded app; the only outbound link is the Theme Editor deep link (5.1.3) |
| 2.2.3 Latest App Bridge, `app-bridge.js` first script | pass | `app/root.tsx`: the CDN `app-bridge.js` tag is the first element in `<head>`; `@shopify/app-bridge-react` ^4.1.6 (`package.json`) |
| 2.2.4 GraphQL Admin API only | pass | every Admin call is `admin.graphql` (`app/mcp/shopifyAdmin.ts`); no REST client (`grep -r "admin.rest" app/` → none); `api_version 2026-07` |
| 2.2.5 Admin extensions feature-complete | n/a | no admin UI extensions (`extensions/` holds the theme app extension only) |
| 2.2.6 No promotions in admin extensions | n/a | none |
| 2.2.7 Max modal only on merchant interaction | n/a | no Max modal |
| 2.2.8 Sidekick extensions align with app functionality | n/a | none |
| 2.2.9 No promotions in Sidekick extensions | n/a | none |

### 2.3 Seamless and secure installation

| Requirement | Status | Evidence |
|---|---|---|
| 2.3.1 Install only from a Shopify-owned surface | pass | managed installation; `/auth/login` redirects to Shopify's install and never shows a myshopify.com form (`test/authLogin.test.ts`) |
| 2.3.2 Authenticate immediately after install | pass | managed installation grants scopes before the app loads; the first embedded load exchanges the session token for the offline token before any UI (`afterAuth`) |
| 2.3.3 Redirect to the app UI after installation | pass / needs-live-evidence | after the grant Shopify opens `/app` (Home). Live: the first frame after install on a brand-new store (screencast item) |
| 2.3.4 OAuth immediately after reinstall | pass | token exchange runs on every (re)install; the reinstall path reactivates the tenant (`app/lib/provision.ts::authNeedsProvision`, `test/provision.test.ts`; live 2026-09-25 step 5) |

## 3 — Security

| Requirement | Status | Evidence |
|---|---|---|
| 3.1.1 Valid TLS/SSL certificate | pass / needs-live-evidence | `https://store.busymate.ai` and `https://busymate.ai` (Let's Encrypt via nginx). Live: `curl -sI https://store.busymate.ai/api/bmai/status` shows a valid chain on submission day |
| 3.2.1 `read_all_orders` only if necessary | n/a | not requested (`shopify.app.toml` scopes: `read_products,read_content,read_legal_policies,read_orders,read_customers,read_fulfillments,write_orders,read_returns,write_returns`) |
| 3.2.2 `write_payment_mandate` only if necessary | n/a | not requested |
| 3.2.3 `write_checkout_extensions_apis` only if necessary | n/a | not requested |
| 3.2.4 `read_advanced_dom_pixel_events` only if necessary | n/a | not requested |
| 3.2.5 `read_checkout_extensions_chat` only when required | n/a | not requested (the assistant is a theme app embed, not a checkout chat) |
| Protected customer data access (Level 1 + 2) | needs-live-evidence | Partner Dashboard → API access requests → Protected customer data: **Draft** (2026-09-24). Fields used: Name, Address, Phone (`app/mcp/tools/returns.ts::update_shipping_address`); no tool reads Email. Owner action in `2026-10-resubmission-5.1.2.md` → "Before resubmitting" |
| Mandatory compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) | pass | `shopify.app.toml` `compliance_topics`; `app/routes/webhooks.compliance.tsx` + `app/lib/compliance.ts` (`test/compliance.test.ts`); HMAC-verified without a session, 200 with an expired session, 401 on a bad HMAC — live on the host 2026-10-02 (`2026-10-02-webhooks-proof.md`) |
| Lifecycle / billing / domain webhooks never fail on a dead session | pass | 0.1.15: every `app/routes/webhooks.*.tsx` is session-free (`test/webhookAuth.test.ts`, `test/webhookRoutes.test.ts`); live probe `2026-10-02-webhooks-proof.md` |
| Expiring offline access tokens (apps created after 2026-04-01) | pass | `future.expiringOfflineAccessTokens: true`; every background Admin call via `unauthenticated.admin(shop)` (`app/mcp/shopifyAdmin.ts`); audit on the host 2026-10-02: 0 permanent offline sessions (`npm run tokens:audit`, `2026-10-02-webhooks-proof.md`) |
| Credentials never logged | pass | `id_token` / `hmac` / `session` / `code` / `signature` redacted from the access log (`app/lib/logRedact.ts`, `test/logRedact.test.ts`); host journal 7 d: 0 raw `id_token` values (2026-10-02) |

## 4 — App Store listing

### 4.1 Brand your app name uniquely and consistently

| Requirement | Status | Evidence |
|---|---|---|
| 4.1.1 App name fields similar (Dev Dashboard ↔ submission) | needs-live-evidence | Dev Dashboard app name "Busymate AI" (`shopify.app.toml` `name`); confirm the submission form's name field reads the same |
| 4.1.2 Unique app name | needs-live-evidence | "Busymate AI" — confirm no identical / confusingly similar listing in the App Store search on submission day |

### 4.2 Pricing accurate and in the designated areas

| Requirement | Status | Evidence |
|---|---|---|
| 4.2.1 Accurate and complete pricing information | pass / needs-live-evidence | plans in `app/lib/plans.ts` match `listing/` pricing copy (`test/plans.test.ts`, `test/listing-copy.test.ts`); confirm the Partner form's pricing section lists Free / Starter / Growth / Scale with the same amounts |
| 4.2.2 No pricing in images | needs-live-evidence | the listing screenshots / icon / banner carry no prices — confirm on the uploaded assets |
| 4.2.3 No pricing elsewhere in the listing | pass | `listing/*` intro / details / features / tagline carry no amounts (`test/listing-copy.test.ts`: no numerals and no "pay" wording in those fields; prices live only in `listing/pricing.json`) |

### 4.3 Accurate and truthful listing information

| Requirement | Status | Evidence |
|---|---|---|
| 4.3.1 Indicate if the Online Store sales channel is required | pass | listing states the storefront assistant needs the Online Store (theme app embed) — `listing/` requirements line |
| 4.3.2 Only claim fully supported languages | pass | 14 extension locales (`extensions/storefront-assistant/locales/*`, `test/extensionI18n.test.ts`) match the 14 listing locales (`test/listing-copy.test.ts`) |
| 4.3.3 No stats / unsubstantiated claims in the listing | pass | `test/listing-copy.test.ts` (no numbers-as-claims, no "best"/"#1") |
| 4.3.4 No stats / unsubstantiated claims in images | needs-live-evidence | confirm on the uploaded screenshots |
| 4.3.5 Accurate tags | needs-live-evidence | category "Customer support / chat" tags in the Partner form |
| 4.3.6 No reviews or testimonials in images | needs-live-evidence | confirm on the uploaded screenshots |
| 4.3.7 No reviews or testimonials in the listing | pass | none in `listing/*` |
| 4.3.8 Indicate geographic requirements | pass | none — the app works in every Shopify market; nothing to declare (`listing/`) |

### 4.4 Clear assets and descriptions

| Requirement | Status | Evidence |
|---|---|---|
| 4.4.1 Effective app card subtitle | pass | `listing/*` subtitle (one phrase, no keyword stuffing) — `test/listing-copy.test.ts` length + wording checks |
| 4.4.2 App details guidelines | pass | `listing/*` description + feature list; `docs/LISTING.md` |
| 4.4.3 No misuse of the Shopify brand in graphics | needs-live-evidence | confirm on the uploaded icon / banner |
| 4.4.4 Clear, focused images (actual UI, no desktop backgrounds) | needs-live-evidence | screenshots are the embedded Home / Store connection / storefront chat — confirm the uploaded set |
| 4.4.5 Unique images | needs-live-evidence | confirm no duplicate screenshots in the uploaded set |

### 4.5 Complete and accurate submission

| Requirement | Status | Evidence |
|---|---|---|
| 4.5.1 Sales Channel apps in their category | n/a | not a sales channel |
| 4.5.2 Submit as a regular app | pass | no sales-channel configuration (`shopify.app.toml`) |
| 4.5.3 Demo screencast (onboarding + core features, English) | needs-live-evidence | candidate `5.1.2-proof-live/screencast-5.1.2-reviewer-flow.mp4` (2026-09-25, frame sequence); a continuous recording on a brand-new store with 0.1.15 is the owner's call. The link in the submission must serve 200 (the `api.busymate.net` copy is retired — `2026-10-02-audit.md`) |
| 4.5.4 Test credentials in the testing instructions | needs-live-evidence | "no account required" is set; the demo store's storefront password must be in the instructions (or the demo URL removed) — paste source `testing-instructions.md` |
| 4.5.5 Functional test credentials | needs-live-evidence | the demo store password must open the storefront on submission day |
| 4.5.6 Emergency developer contact | needs-live-evidence | Partner Dashboard → Settings → emergency contact set to `hi@busymate.ai` + the developer phone (confirm) |

## 5 — Category-specific

### 5.1 Online Store

| Requirement | Status | Evidence |
|---|---|---|
| 5.1.1 Theme changes only through theme app extensions | pass | one app embed block `extensions/storefront-assistant/` (`shopify.extension.toml`); no theme file writes, no `read_themes` / `write_themes` scope (`test/appConfig.test.ts`) |
| 5.1.2 Theme app extension shown properly in the Theme Editor and storefront | pass (2026-09-25 live run) / needs-live-evidence (submission-day re-run) | nine causes fixed and proven live, steps 1–8 pass (`2026-10-resubmission-5.1.2.md`); Home never offers the CTA before the frame can open (0.1.14) and never sits stale (0.1.15). **Live:** re-run steps 3–8 on a brand-new dev store the day of resubmission, incl. uninstall → reinstall within 3 min and close-everything-reopen |
| 5.1.3 Detailed onboarding for the extension, deep link recommended | pass | Home "Turn on the storefront assistant" deep link `…/editor?context=apps&activateAppId=<client_id>/assistant` + "Or do it by hand" steps ending in Save (`app/lib/themeEmbed.ts`, `test/themeEmbed.test.ts`); never held on "couldn't ask" (`test/homeActivation.test.ts`) |
| 5.1.4 App-name branding only where customers interact with it | pass | the launcher label is the merchant's ("Ask us", editable in the embed settings); the chat shows the store's assistant, not "Busymate AI" (P02 / P04 in `5.1.2-proof-live/`); "Busymate AI assistant" appears only in the merchant's Theme Editor embed list |
| 5.1.5 Collected data back to the merchant | pass | Conversations page (`app/routes/app.conversations.tsx`, `list_tenant_conversations`, `test/conversations.test.ts`) |

### 5.2 – 5.11 Other categories

| Section | Status | Evidence |
|---|---|---|
| 5.2 Payment (5.2.1–5.2.15) | n/a | not a payments app |
| 5.3 Payment Facilitator (5.3.1–5.3.3) | n/a | — |
| 5.4 Purchase Option (5.4.1–5.4.19) | n/a | no selling plans / subscriptions |
| 5.5 Product Sourcing (5.5.1–5.5.5) | n/a | — |
| 5.6 Checkout Customization (5.6.1–5.6.9) | n/a | no checkout UI extension |
| 5.7 Sales Channel (5.7.1–5.7.18) | n/a | — |
| 5.8 Post Purchase (5.8.1–5.8.10) | n/a | — |
| 5.9 Mobile App Builders (5.9.1–5.9.3) | n/a | — |
| 5.10 Donation (5.10.1–5.10.7) | n/a | — |
| 5.11 Blockchain (5.11.1–5.11.13) | n/a | — |

## Open items (needs-live-evidence), in the order to collect them

1. Protected customer data request: Draft → submitted (Name, Address, Phone; Email deselected).
2. Partner form: app name, pricing section, tags, emergency contact, support email `hi@busymate.ai`,
   screencast link serving 200, testing instructions pasted from `testing-instructions.md` with the demo
   store password.
3. Uploaded assets: no prices, stats, reviews or Shopify-brand misuse; unique, UI-only screenshots.
4. Deploy 0.1.15 (SETUP §3b) and re-run `npm run webhooks:probe` against the live unit (expected 10/10).
5. Submission-day live run on a brand-new dev store: `2026-10-resubmission-5.1.2.md` steps 3–8
   (fresh install → Home re-checks by itself → CTA → Save → chat; anonymous storefront; uninstall →
   reinstall within 3 min → Home shows Live without a reload; close everything and reopen).
6. `curl -sI https://store.busymate.ai/api/bmai/status` (TLS chain) the same day.
