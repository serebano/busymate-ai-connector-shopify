# App Store review — resolution record

> **Current (2026-09-25):** the review was suspended until 2026-10-08 on 5.1.2 ("refused to
> connect" in the Theme Editor). Causes, fixes, verification steps and the full requirement
> checklist: [`2026-10-resubmission-5.1.2.md`](2026-10-resubmission-5.1.2.md). Resubmission
> is held for the owner.

**Historical record of the August review fixes, not current release certification.**
The September 11 review and September 12 verification found additional provisioning,
theme-preview, runtime-projection and resolution-metering gaps. Those findings supersede
the earlier all-resolved assessment below. Current tracking:
[review fixes #16](https://github.com/serebano/busymate-ai-shopify/issues/16) and
[resolution metering #19](https://github.com/serebano/busymate-ai-shopify/issues/19).
Resubmission remains pending until live verification is complete.

Two reviews reached us: **Aug 29** (2.1.1 / 2.1.3 — the embedded app returned a web `500`
on first load) and **Aug 31** (Shopify reference 132497 — **1.2.1** "changing plans inside
the app resulted in a 404 … no billing options visible under Manage apps"). The first
section below is the original proof for 2.1.1 / 2.1.3; the sections after it record the
1.2.1 fix and the further findings our own re-audit against the App Store requirements
turned up (expiring offline tokens, grounded knowledge, reinstall, App Proxy identity,
`/auth/login`) — each with the root cause, the fix, and how to verify it live.

## 2.1.1 / 2.1.3 — the embedded app provides an interactive UI (500 fixed)

This is the proof of resolution for the two requirements raised in the Aug 29 review. Both
stem from the **same** root cause — the embedded app returned a `500 Internal Server Error`
on the first load after installation — which is now fixed.

## What the review reported

| # | Requirement | Reviewer note |
|---|---|---|
| 2.1.3 | Have a user interface (UI) that merchants can interact with | "During launch, the embedded app progressed through blank and loading states but fails to provide an interactive UI, ending with **500 Internal Server Error.**" |
| 2.1.1 | Build apps without critical errors to ensure review completion | "While testing the embedded app after installation, the app failed to recover to usable merchant content and displayed **500 Internal Server Error.**" |

## Root cause

Shopify's managed token-exchange install flow persists the session and then runs the app's
`afterAuth` hook. Our `afterAuth` ran a one-time backend provisioning step. If that step threw
on a transient condition during the **first** load (for example a write-race from App Bridge's
double install request), Shopify's strategy converts the throw into a bare `500` on that first
embedded page — with no body and no interactive UI. An already-set-up store never re-runs the
step, which is why the error only appeared on a fresh install.

## The fix

Provisioning on install is now **fail-open** and can never surface as a web error:

- The install/`afterAuth` path no longer throws. A provisioning hiccup is recorded as an
  in-app operational status (with a one-click **Retry**), and the app **always** renders its
  interactive UI. This matches requirement 2.1.3, which permits operational errors but not web
  `500`/`404`/`3xx` errors.
- Every embedded route (`Home`, `Assistant settings`, `Connector & data`, `Billing`) renders
  under the Polaris app provider and returns `200`.

## After the fix — the interactive UI renders

![Busymate AI embedded app — interactive merchant UI](embedded-app-working.png)

The embedded app opens to an interactive dashboard: the assistant status, a link to open the
assistant, the connector panel, and billing — with working navigation to each settings page.

## How to verify

1. Install **Busymate AI** on a development store.
2. Open the app from **Apps → Busymate AI** in the Shopify admin.
3. The app loads its interactive UI (no `500`); every page — Home, Assistant settings,
   Connector & data, Billing — renders and is navigable.

Verified live on `https://store.busymate.ai`: the full install → `afterAuth` → embedded-app
path returns `200`, and all embedded routes return `200` with zero `500`s.

## 1.2.1 Billing — Shopify App Pricing enabled + in-app plan flow

**What the reviewer saw (Aug 31):** "attempting to change plans inside the app resulted in
a 404 error … no billing options are visible under Shopify's Manage Apps section."

**Root cause.** The app was built for **Shopify App Pricing** (the in-app "Choose a plan"
button opens Shopify's hosted plan-selection page
`admin.shopify.com/store/<store>/charges/busymate-ai/pricing_plans`), but App Pricing had
never been **enabled** for the app — the Partner pricing manager was still on "Manual
pricing" (listing-display plans only). Shopify serves that hosted page only for apps with
App Pricing enabled, so it `404`ed on every store, and because no subscription had ever
been created through Shopify, "Manage apps" listed no billing options.

**The fix.**

- **Shopify App Pricing is enabled** (Partner Dashboard → Pricing → "Update to App
  Pricing", 2026-09-02) with four public plans — `free` ($0), `starter` ($19/mo),
  `growth` ($99/mo), `scale` ($349/mo) — 14-day trials on paid plans, **free for partners
  and development stores** (reviewers test without subscribing), one usage event
  `ai_resolution` per paid plan (tiered-graduated: the plan's included resolutions at $0,
  then $0.49 / $0.44 / $0.42 per extra resolution), and a redirect URL of `/app/billing`.
- **In-app plan flow** — `app/routes/app.billing.tsx` shows the same four plans from the
  single plan catalog (`app/lib/plans.ts`, asserted against `listing/pricing.json`),
  "Choose a plan" navigates **top-level** to Shopify's hosted plan page (no new tab,
  no 404), and Shopify redirects back to `/app/billing?plan_handle=<plan>`.
- **Plan state comes from Shopify** — `app/lib/partnerApi.ts` reads the Partner API
  **Active Subscription** endpoint (the App Pricing source of truth; App Pricing no longer
  sends `app_subscriptions/update` after activation) and the `plan_handle` redirect
  parameter; the legacy `currentAppInstallation.activeSubscriptions` reconcile stays as a
  fallback. The **Free plan is modelled** (`app/lib/billingGate.ts`): a store with no paid
  subscription is on Free — no permanent "Choose a plan to start" warning.
- **Usage metering** reports `ai_resolution` events through the **App Events API**
  (`app/lib/appEvents.ts`, `POST /api/billing/meter`, hourly timer), cap-clamped; the
  assistant is never switched off for billing.
- Copy on Home / Billing is factual (monthly plan with included resolutions, then a
  per-resolution price up to a monthly cap) and identical to the listing's pricing.

**How to verify.** Open the app on a development store → **Billing** → "Choose a plan" →
Shopify's plan-selection page renders (no 404) → pick a plan (free for dev stores) →
redirected back to Billing showing the chosen plan → Shopify admin → **Settings → Apps and
sales channels → Manage apps** lists Busymate AI with its plan.

## Expiring offline tokens

**Root cause.** Busymate AI is a public app created after 2026-04-01, so Shopify requires
**expiring** offline access tokens; the app requested permanent ones (the library in use
predated the `expiringOfflineAccessTokens` flag). Shopify rejected every Admin API call
with `403 Non-expiring access tokens are no longer accepted`, and the Dev Dashboard showed
"Deprecated offline token use detected".

**The fix.** `@shopify/shopify-app-react-router` 2.1.0 with
`future.expiringOfflineAccessTokens: true`; `Session.refreshToken` /
`refreshTokenExpires` columns (encrypted at rest, additive migration); every background
Admin call resolves the shop's session through the library (`unauthenticated.admin`,
`app/mcp/shopifyAdmin.ts`), which refreshes within 5 minutes of expiry; pre-upgrade
permanent tokens are exchanged once with `scripts/cycle-offline-tokens.ts`
(`api.auth.migrateToExpiringToken`). Tests: `test/shopifyConfig.test.ts`,
`test/shopifyAdmin.test.ts`, `test/encryptedSessionStorage.test.ts`,
`test/prismaSessionSchema.test.ts`, `test/cycleOfflineTokens.test.ts`.

**How to verify.** New installs store a ~1 h token + refresh token; Admin calls (catalog
training, order lookups, metering) succeed; the Dev Dashboard warning is a trailing-30-day
window and clears on its own once no deprecated calls remain.

## Grounded knowledge (the assistant answers from the store)

**Root cause.** The listing promises answers grounded in the store's products and
policies, but the app's "auto-train" never landed: it sent a `kb_snapshot` argument that is
not part of the platform's `publish_tenant_runtime` contract, so it was silently ignored and
every store's assistant answered from an empty knowledge base.

**The fix.** At install (and on every re-auth / reinstall) the lifecycle reads the store's
**products** (title, handle, price, short plain-text description, URL), **shop policies**
(type, title, body as text, URL) and **pages** (title, body as text, URL) through the
Admin API (`app/lib/kbFetch.ts`; scopes `read_products`, `read_content`,
`read_legal_policies`), compresses them deterministically into the platform's
`knowledge_sources` shape within its limits (`app/lib/kbSnapshot.ts`: policies → products
→ pages, whole items, an explicit "+N more" note when trimmed) and publishes them in the
**same** `publish_tenant_runtime` call that takes the tenant live. Product webhooks
re-train (debounced per shop); **Store connection → "Re-train on my store"** re-runs it on
demand and reports the real counts. The training state (`Trained on N products, M
policies, K pages · last trained …`, or the error) is persisted on the store record and
shown on **Home** and **Store connection**; ingest errors are logged and surfaced, never
swallowed. Tests: `test/kbSnapshot.test.ts`, `test/kbTrain.test.ts`,
`test/provision.test.ts`, `test/prismaTrainingSchema.test.ts`, `test/themeEmbed.test.ts`.

**How to verify.** Install on a development store with products and policies → Home shows
"Trained on N products, M policies, K pages" → on the storefront ask "What do you sell?" or
"What is your return policy?" → the assistant answers from the catalog / policy with a
citation, and says when it is not sure.

## Reinstall

**Root cause.** `app/uninstalled` suspends (archives) the store's assistant on the
platform. A reinstall re-ran provisioning, which returned the same archived tenant, so the
app said "Live" while the assistant host stayed archived.

**The fix.** `provision_partner_tenant` now **reactivates** an archived tenant under a
valid proof-of-shop (`reactivated: true`); the lifecycle re-publishes the runtime
(origins + knowledge), records `published` and Home shows **Live** again; uninstall still
purges the store's sessions, so a reinstall authenticates immediately (Req 2.3.4) and mints
a fresh expiring token. Test: `test/provision.test.ts` ("REINSTALL …").

**How to verify.** Uninstall the app on a development store → reinstall from the listing
→ the app opens straight into its UI, Home shows Live + Trained, the storefront widget
answers again.

## App Proxy / identity (order-aware answers for signed-in shoppers)

**Root cause.** The storefront widget posts the signed-in customer signal to
`/apps/busymate-ai/identity`, which only resolves through a Shopify **App Proxy**;
`shopify.app.toml` declared none, so the request 404ed and every shopper was treated as a
guest.

**The fix.** `[app_proxy] url = "https://store.busymate.ai", subpath = "busymate-ai",
prefix = "apps"` (shipped in app version `busymate-ai-5`) → Shopify HMAC-signs and proxies
the request to `/identity` (`app/routes/identity.tsx`), which verifies it and mints the
customer-scoped launch token. `test/appConfig.test.ts` pins the proxy path to the widget's
`IDENTITY_URL`.

**How to verify.** Sign in as a customer on the storefront → "Ask us" → "Where is my
order?" → the assistant answers for that customer's own orders (guests are asked to sign
in and offered a human).

## `/auth/login`

**Root cause.** The library's configured login path was routed to `authenticate.admin`,
which the library rejects with a web `500`; any non-embedded request to `/app*` (a stale
tab, a bookmark, a reviewer opening the app URL directly) ended there.

**The fix.** `app/routes/auth.login.tsx` calls the library's `login(request)`: a valid
`shop` → `302` into Shopify's managed install; no shop → `302` to the branded root (which
points at the App Store listing — no manual `myshopify.com` entry, Req 2.3.1). Never a
`500`. Test: `test/authLogin.test.ts`; live gate: `curl -A "<Chrome UA>" -o /dev/null -w
'%{http_code}' https://store.busymate.ai/auth/login` → `302`.

## In-app navigation (Polaris links inside the admin iframe)

Found live on 2026-09-02 after the busymate-ai-5 release, before resubmission: the
Home page's "Manage store connection" / "Re-train" / "Manage plan" links (Polaris
`<Link url>`) navigated the admin iframe to a **bare** app URL (no `host` / `shop` /
`embedded` / `id_token`). The embedded auth cannot serve such a document request, so
the merchant landed on the branded error page — a reviewer clicking through the
setup checklist would have hit it (Req 2.1.3).

Root cause: `@shopify/shopify-app-react-router` 2.x's `AppProvider` no longer provides
Polaris React context (it injects App Bridge + Polaris web components and routes
`shopify:navigate` events, which plain anchors never dispatch), so the nested Polaris
`AppProvider` must carry a router-aware `linkComponent`. Fix: `app/components/PolarisLink.tsx`
— internal paths render a React Router `<Link>` (client-side, session-token data
requests); absolute URLs, `external` and an explicit `target` (the theme-editor deep
link's `_top`) stay real anchors. Tests: `test/polarisLink.test.ts` (rendered markup +
the `app.tsx` wiring).

## Existing installs learn new scopes (app/scopes_update)

A scope grant (the `read_legal_policies` added for training) keeps the existing
offline session — no token exchange, no `afterAuth`, so the install lifecycle and
its training do not re-run on their own. The `app/scopes_update` webhook now records
the new scope set on the session **and queues a debounced re-train**
(`app/lib/scopesUpdate.ts`, `test/scopesUpdate.test.ts`), so every existing store is
trained as soon as its merchant approves the new version's permissions.
