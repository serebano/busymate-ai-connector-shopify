# Changelog

Newest first. Each entry names the app-repo commit on `main`, the Shopify app version
it released (Dev Dashboard → Versions) and the host build serving
`https://store.busymate.ai`.

## 2026-10-02 — 0.1.15: Home re-checks while the runtime settles; webhooks never 5xx on a dead session; webhook + token compliance proof; requirements matrix

Owner order 2026-10-02 "make the Shopify connector 100% ready" (busymate-devtools#3995).

**Home stale badge after a reinstall** (found live on `busymate-ai-review-test-7`, app 0.1.14): right
after a reinstall Home painted "1/4 done · Activating" and "Assistant provisioned: To do — waiting to
become active" while "Turn on the storefront assistant" was already ENABLED — the platform's
`/api/embed-status` answered `frameable:true` before the runtime-readiness read said `ready` — and no
self re-check ran, because the re-check was tied to the HOLD (`activating`), which is off whenever the
CTA is offered. The badge stayed stale until a manual reload ("2/4 · Live").

- `app/lib/homeActivation.ts` now returns `{ embedReady, activating, recheck }`: the RE-CHECK condition
  is separate from the HOLD condition. Home keeps re-checking (5 s × 5 min, then 30 s) whenever the
  runtime is not yet `ready` — pending / orphaned / unverified / null while published, or not published
  at all — even while the CTA is offered; the "being activated" banner stays tied to the hold only. A
  runtime `error` is the one settled non-ready state and is never re-polled (Retry setup re-runs the
  lifecycle). `app/routes/app._index.tsx` wires `useActivationRecheck(data.recheck)`.
- `app/lib/runtimeReadiness.ts`: the pending / unverified copy no longer says "Refresh to check again"
  (the page checks by itself).
- `test/homeActivation.test.ts`: the reinstall case (published, runtime pending, frameable true →
  embedReady true, activating false, recheck true), the ready case (recheck false) and an exhaustive
  arm sweep (`recheck === activating || runtime not settled`; an offered CTA is never "activating").

**Webhooks never answer 5xx on a dead session** (owner item d). `authenticate.webhook` loads the
shop's offline session and, under expiring offline tokens, REFRESHES it first; after an uninstall, or
for a shop whose refresh token Shopify no longer honours, that refresh fails and the library throws a
500 — Shopify retries, then DELETES the subscription after 8 failures. 0.1.13 moved
`app/uninstalled` and the three GDPR topics off that path; 0.1.15 moves EVERY webhook route:

- `app/routes/webhooks.domains.tsx`, `webhooks.app_subscriptions.update.tsx`,
  `webhooks.app.scopes_update.tsx`, `webhooks.kb.products.tsx`, `webhooks.kb.orders.tsx` verify the
  HMAC with `authenticateWebhookWithoutSession` and ack 200 at once; the Admin-API work (the domains
  refresh, the re-train) already ran in the background through `unauthenticated.admin(shop)` with
  its own error handling, and `app/scopes_update` records the new scope set on the offline session
  row by its deterministic id (`offlineSessionId(shop)`, `app/lib/webhookAuth.ts`) without loading or
  refreshing it.
- `test/webhookAuth.test.ts` derives the route list from `app/routes/webhooks.*.tsx` (no webhook
  route may import `authenticate.webhook`); `test/webhookRoutes.test.ts` drives every route's action
  with HMAC-signed deliveries for a shop whose offline session is EXPIRED or MISSING: 200 on each
  topic, 401 on a bad HMAC, and the session store is never read.
- `scripts/webhook-probe.ts` (`npm run webhooks:probe`): the HMAC-signed synthetic delivery run from
  the host — seeds `probe-expired-<ts>.myshopify.com` with an EXPIRED offline session in the app DB,
  POSTs every topic to `127.0.0.1:<port>`, checks 200 / 401, deletes the synthetic rows; value-blind.
- `scripts/offline-token-audit.ts` (`npm run tokens:audit`): read-only, value-blind counts of the
  `Session` table — offline sessions, permanent (`expires IS NULL`), without a refresh token, expired
  now — the check SETUP §3c asks for after `tokens:cycle`.
- Live results + the expiring-offline-token audit: `docs/review/2026-10-02-webhooks-proof.md`.
  Requirements matrix (every numbered App Store requirement with status + evidence):
  `docs/review/requirements-matrix.md`.

Server-side only; no Shopify app version is released by this change.

## 2026-10-02 — 0.1.14: Home holds the embed CTA and re-checks while the tenant is still provisioning (review 5.1.2, audit of the 2026-09-24 screencast 2)

Reproduced on 2026-10-02 on a fresh install (`busymate-ai-review-test-6`, app 0.1.13): Home's first
paint landed ~5 s after the install while `afterAuth` was still publishing the tenant. The row still
read `provisionState: "pending"`, so `published` was false and (a) the self re-check never started —
Home sat on "0/4 done · Provisioning" until a manual reload — and (b) `embedCtaReady(null, null)`
answered true, so "Turn on the storefront assistant" was ENABLED for a tenant that did not exist yet.
That is the reviewer's second 2026-09-24 screencast frame for frame.

- `app/lib/homeActivation.ts`: the ONE derivation of `embedReady` + `activating`. A tenant that is
  not published yet (`pending`, `suspended` during a reinstall) is activating: the CTA is held and
  Home re-checks by itself (5 s × 5 min, then 30 s with Retry setup) until it is published AND the
  platform says the chat can be framed. A provisioning `error` holds the CTA without the spinner
  (the "Provisioning needs attention" banner with Retry setup already covers it).
- `app/routes/app._index.tsx` uses it; `test/homeActivation.test.ts` pins every arm.

Server-side only; no Shopify app version is released by this change.

## 2026-09-25 — 0.1.13: uninstall and GDPR webhooks no longer answer 500 after the offline token expires (busymate-devtools#3731)

Commit `50d3c6a` on `main`; host deployed 2026-09-25 03:53 UTC (SETUP §3b). No Shopify app
version was released: the change is server-side only.

Found during the 5.1.2 live acceptance run: the Dev Dashboard showed a 51.4 % webhook
failure rate. `authenticate.webhook` refreshes an expired offline token before it returns,
and after an uninstall that refresh fails, so `app/uninstalled` and the compliance topics
answered 500 whenever the shop's token was more than about 55 minutes old. The tenant was
never suspended, the sessions were never purged, and `shop/redact` could never run.

- `app/lib/webhookAuth.ts`: `authenticateWebhookWithoutSession` checks what the library
  checks first (POST, HMAC over the raw body, the required headers) and never loads or
  refreshes a session. The topic is normalised the same way (`app/uninstalled` →
  `APP_UNINSTALLED`).
- `webhooks.app.uninstalled.tsx` and `webhooks.compliance.tsx` use it. Other webhook routes
  keep `authenticate.webhook`, because they call the Admin API.
- `test/webhookAuth.test.ts`: signature, fail-closed 401/400/405, topic keys, and a pin
  that the two routes never call `authenticate.webhook`.

## 2026-09-25 — 0.1.12: Shopify review 5.1.2 — the storefront chat never opens "refused to connect" (busymate-devtools#3718)

App Review paused (ref 132497) on 5.1.2: the app embed's chat showed "busymate.ai refused
to connect" in the Theme Editor, and the widget was gone after a reopen. The causes were on
our side (platform readiness deadlock on reinstall, a publish-to-frameable window, legacy
allowlists without the Theme Editor frames, an orphaned tenant); the platform half ships in
busymate-devtools (`fix/shopify-512`). This app half:

- **afterAuth is idempotent** (`authNeedsProvision`): expiring offline tokens re-exchange
  about hourly and each exchange re-ran the whole lifecycle — a new published revision per
  admin open, each reopening the activation window. A live tenant is no longer
  re-published; a new, reinstalled or errored one is. A live one is CHECKED in the
  background instead (`app/lib/tenantRepair.ts`) and repaired, gated to once per shop per
  10 min, only on a definite answer:
  - **orphaned** — `get_tenant_integration` answers that the tenant is gone
    ("administration denied" / "unavailable") → a first-class `orphaned` readiness state
    (`app/lib/runtimeReadiness.ts`); no meter flag needed. Home repairs it on load too;
  - **storefront domain missing** — the store has a domain its published allowlist lacks.
  A successful publish clears the meter's `tenantUnreachableAt`, so a repaired tenant is not
  re-repaired every 10 min until the next hourly meter run.
- **`domains/create|update|destroy` webhooks** (`app/routes/webhooks.domains.tsx`, no
  scope needed; active on the next `shopify app deploy`, which also releases the
  `assistant.js` hardening below — one decision) re-read the store's domains and repair the
  allowlist when one is missing.
- **Home's "Turn on the storefront assistant"**: the platform's frameability answer
  (`/api/embed-status`, Online Store + Theme Editor chain) decides whenever it answered —
  `true` enables the CTA even while the readiness read is unverified or pending, `false`
  holds it; only an unanswered check falls back to readiness, and "couldn't ask" never
  holds it. While held, Home re-checks every 5 s for 5 min, then every 30 s with a
  "taking longer" banner and Retry setup — it never stops. One loop runs per hold
  (`app/lib/activationRecheck.ts` + `useActivationRecheck`): the first version listed
  react-router's revalidator as an effect dependency, which is a new object on every
  re-check, so the loop restarted each time and the banner never came
  (`test/activationRecheck.test.ts` drives the hook in a real data router). The embed step
  says the embed stays on only after Save.
- **Embed detector** matches the `assistant.js` asset tag + this store's `data-slug`
  (the hard-coded CDN UUID `01a04ae4…` said "off" for the live `busymate-ai-5` embed).
- **Storefront domains** (primary + others, Admin API) join the embed-origin allowlist on
  every provisioning run, so a custom-domain storefront is never refused.
- **Reconcile sweep** `npm run tenants:reconcile [-- --apply <shop>…]` (SETUP §3c-ter):
  orphaned (no flag) / stuck / domains-missing / refused tenants re-provisioned; its
  frameability check asks every custom domain too; dry-run by default.
- **Access log redaction**: `id_token`, `hmac`, `session`, `code`, `signature`, … are
  replaced in the host's request log (`app/lib/logRedact.ts`).
- **Extension (`assistant.js`) hardening, NOT released**: retries `/embed/v1.js` with
  backoff, a plain link to the hosted assistant if the loader cannot load, tolerates a null
  `document.currentScript`, re-ensures the launcher after a Theme Editor section
  re-render. Needs a new extension version; the release is held for the owner.

## 2026-09-13 — 0.1.11: zero-usage display + quiet skip for a deprovisioned tenant (#19)

Two review-store bugs found verifying the metering counter (0.1.9/0.1.10):

- **Billing page showed "Resolution usage is currently unavailable" for a
  ZERO-usage store.** `measuredCycleResolutions` required a truthy `cycleKey`
  as a proxy for "a real measurement happened" — but `meterShop`'s
  zero-resolution and Free-plan paths never populate `cycleKey` (that's its
  OWN cycle-reset bookkeeping, unrelated to display trust). A fully-validated
  `v:1` payload with a safe-integer `cycleResolutions` already proves the
  count is real on its own. Dropped the redundant, buggy gate — a genuinely
  observed zero now renders "0 of N included resolutions used" next to the
  definition, never "unavailable". `test/usageDisplay.test.ts`.
- **5 of 6 installed shops reported "resolutions unreadable" every hourly
  meter run** — their `bmaiTenantId` had drifted stale (deprovisioned/archived
  on the platform side); every read was refused
  `tenant_management_denied`. That is a KNOWN, stable condition, not a
  transient failure: the ledger now treats it as a quiet zero (never
  "unreadable"/held) and flags the shop (`ShopTenant.tenantUnreachableAt`,
  new migration `20260913130000_tenant_unreachable_flag`) so it logs ONCE on
  the first denial and ONCE on recovery — never once per run. A genuinely
  unexpected error still fails closed exactly as before.
  `app/lib/resolutionLedger.server.ts`, `test/resolutionLedger.test.ts`.

597 tests across 64 suites; typecheck, lint and production build green.

## 2026-09-13 — 0.1.10: single-flight token refresh (incident fix, #19)

- **Incident:** two concurrent MCP calls on a cold token cache each refreshed the
  shared `mgmt` OAuth credential; the edge read the second POST of the same
  rotating refresh token as replay and revoked the token family — a latent
  app-wide outage. Credential re-minted value-blind and the service restarted.
- **Fix:** `app/lib/bmaiToken.ts` coalesces concurrent refreshes into ONE shared
  in-flight grant and makes `invalidate(staleToken)` token-aware; the 401 retry in
  `app/bmai.server.ts` reuses it; `app/lib/resolutionLedger.server.ts` reads
  conversations then handoffs sequentially. Regression tests added. Full write-up:
  `docs/BILLING.md` → "Incident 2026-09-13".

## 2026-09-13 — 0.1.9: the AI-resolution metering counter (#19)

- The last review gap: `usageBilling.ts` read `get_tenant_usage`, which returns
  tenant entity counts, not a resolutions/cursor pair — usage was permanently
  unreadable. Replaced with a real producer (`app/lib/resolutionLedger.server.ts`)
  reading `list_tenant_conversations` + `list_tenant_interventions` (all
  statuses) and applying the boss-default definition (`app/lib/
  resolutionDefinition.ts`, `docs/BILLING.md`): **a billable AI resolution is a
  visitor conversation the assistant answered that ended without a human
  hand-off, and was not reopened by the same visitor within 24 hours.**
- New idempotent ledger `MeteredResolution` (`@@unique([tenantId, sessionId])`)
  — a conversation is counted at most once, ever, however many times the
  rolling recent-conversations window re-surfaces it.
- Wired the previously-unwired prepared-batch outbox (PR #28 / issue #27,
  `app/lib/meterOutbox.ts`, cherry-picked verbatim) into `meterShop`: a
  billable batch is `prepare`d, `claim`ed (30s DB-clock lease), sent to
  Shopify App Events, then `accept`ed — durable against overlapping
  timer/page-load metering and an API-success/DB-failure retry. A delivery
  whose billing snapshot changed mid-flight moves to `reconciliation`
  (dead-letter) and is surfaced as a critical Billing-page banner, never
  silently retried. Supersedes PR #28 — see `docs/BILLING.md`.
- Billing page shows the definition text next to the current-cycle count.
- New migration `20260913090000_metered_resolution_ledger` (additive).
- Tests: `test/resolutionDefinition.test.ts`, `test/resolutionLedger.test.ts`
  (new, 17 tests) + `test/meterOutbox.test.ts` (19, cherry-picked). 584 tests
  across 64 suites; typecheck, lint, production build all green;
  `meterShop`'s existing tested allowance/cap logic is unchanged.

## 2026-09-13 — 0.1.8: layout-level in-frame recovery (review 2026-09-11, Req 2.1.1)

- Reproduced live on the review store: a Home fetcher action followed by the layout
  revalidation `GET /app.data` failing as `AbortError` (client-aborted) rendered the
  root "500 Something went wrong" document inside the admin. The `/app` layout
  boundary now hands only thrown Responses (session-token bounce, redirects, 4xx)
  to the SDK's `boundary.error`; every other loader failure recovers in-frame with a
  merchant-facing banner and a reload retry that re-enters the session-token bounce.
- Home loader reads the storefront embed and the integration record concurrently
  (one round-trip instead of two), shrinking the revalidation window.
- A client-aborted request is logged as `route_aborted` (info), never counted as a
  500. Tests: `test/layoutError.test.ts`.

## 2026-09-12 — 0.1.7: safe embedded-route diagnostics

- Log allowlisted authentication/route failure metadata without queries, credentials,
  messages, stacks, headers, request bodies or customer identity. SDK response
  identity, status and recovery headers remain unchanged.
- Installed-SDK regression covers a synthetic failed offline-token exchange and
  successful retry. The unexplained idle-navigation 500 is not claimed fixed.

## 2026-09-12 — 0.1.6: refuse invalid resolution batches

- Hold the stored cursor and send no billing event for invalid resolution counts,
  empty/non-string cursors, or a positive batch repeating the stored cursor.
- App Events rejects fractional and unsafe integer units instead of rounding them.
- This defensive validation does not implement the resolution ledger, serialized
  delivery, or the Free allowance; those remain prerequisites for verified metering.

## 2026-09-12 — 0.1.5: keep session-recovery context across admin navigation

- Internal navigation now carries the authenticated shop, its supported Shopify
  admin host encoding, and embedded mode. Hard reloads enter the SDK's session-token
  bounce instead of its contextless blank bootstrap response.
- No session token is copied into links; Shopify still obtains and verifies a fresh
  token. Both navigation menu and Polaris links use the shared context.
- Regression exercises the installed SDK and verifies the recovery redirect and
  return path. Live end-to-end recovery remains a separate release check.

## 2026-09-12 — 0.1.4: preserve embedded session recovery after navigation

- Preserve constructor names during client minification. Shopify's session-token
  response boundary identifies React Router errors by name; renaming the class
  caused successful recovery responses to become a branded 200 error after hydration.
- Reproduced on the production build in Chromium: reloading bare `/app` rendered
  the error before this change, and retained recovery without browser errors after it.
- Regression executes the installed Router and Shopify boundary through the real
  minifier, including a negative control with names removed and unrelated errors.

## 2026-09-12 — 0.1.3: verify activation and reconnect existing tenants

- Home and Store connection verify the tenant's current published revision is
  applied and ready before claiming Live/Connected. Pending, failed, and
  unavailable observations remain distinct and can be refreshed.
- Reconnection updates the existing connector, and only reuses connector/provider
  IDs when the provisioned tenant is unchanged.
- Missing or failed resolution measurements display unavailable rather than zero.
- Host deployment, live verification, and review submission are recorded separately.

## 2026-09-12 — 0.1.2: chat inside Shopify's theme editor (#16)

- Publish the two exact Shopify editor ancestors alongside the store origin so
  the chat iframe works inside the nested theme preview. No wildcard origins;
  launch origins remain scoped to the assistant host.
- Install/retry and retraining share the same origin builder.

## 2026-09-12 — 0.1.1: Shopify review fixes (#16)

- Theme activation now uses the installed app's client ID, as required by Shopify's
  current deep-link contract, rather than a CDN asset UUID. Asset detection stays
  separate; missing app identity opens the manual App embeds panel.
- Includes the connector-description fix from `f7665fb`, absent from the previous
  host release. Without it, new assistants could not pass delegated-tool preflight.
- Regression coverage exercises connector rejection through publish failure and
  successful delegated connector registration through publication.
- Local validation: 53 suites / 488 tests, typecheck, lint, production build passed.
- Live verification and review submission are recorded separately after completion.

## 2026-09-02 — fix(#2132 C+D): branding save re-publishes the runtime; honest "No plan selected" billing state · `dc2e004` (PR #9) · host `store.busymate.ai` build 18:38Z

Found by the reviewer simulation on the fresh dev store
`busymate-ai-review-test-5`.

- **FAIL C — assistant rename not reflected in the widget.** Root cause: the settings save
  called only `set_tenant_branding` (the tenant ROW), but the storefront widget renders the
  PUBLISHED runtime revision, whose `brand` the platform synthesizes from that row at
  `publish_tenant_runtime` time — the save never re-published. Fix: `app/lib/brandingSave.ts`
  (set branding → the training re-publish, fail-closed: a failed publish is reported as
  "saved, but not live"); `app/lib/provision.ts` seeds the default names ONLY for a new tenant,
  so a reinstall no longer wipes the merchant's saved names. Live proof on review-test-5 after the
  host deploy: Assistant settings → "Riley Helper" → Save (POST 1.9 s) → tenant row updated
  18:39:48Z → served runtime `assistantName: "Riley Helper"` → a fresh storefront chat greets
  "Hi, I'm Riley Helper" (composer "Message Riley Helper").
- **Review risk D — Shopify "Manage apps → Billing: No plan selected" while the app said
  "Free plan".** Partner API evidence (Active Subscription API, value-blind probe on the host):
  review-test-5 has only `RELATIONSHIP_INSTALLED/UNINSTALLED` events and `activeSubscription = null`
  (no plan was ever selected there); review-test-4, where the Free plan WAS selected, has a real
  contract (`SUBSCRIPTION_CREATED` → item handle `free`, `FlatRatePrice 0.0`, a
  `legacySubscriptionId`). So under Shopify App Pricing the $0 Free plan IS a subscription once
  selected (and then shows under Manage apps); "no contract" must read "No plan selected".
  `billingGate.planSelected` + the Billing page / Home / checklist copy now say exactly that,
  with the Choose-a-plan CTA.
- Tests (RED→GREEN, run): `test/brandingSave.test.ts`, `test/provision.test.ts`,
  `test/billingGate.test.ts` — 461 passing on the host build.

## 2026-09-02 — fix: embedded actions fail closed on the client (the REAL Re-train 500) · host `store.busymate.ai`

Follow-up to the hydration fix below. Traced live in the admin iframe
with a CDP network/console trace on the fixed build: the "500 Something went wrong" after
**Re-train on my store** was NOT the hydration mismatch (that was real, and is gone — no React
#418/#425/#423 at load any more) but a **failed action fetch**.

- **Root cause** — the fetcher `POST /app/connector.data` died in transit (Chrome
  `net::ERR_NETWORK_CHANGED`; nginx logged **499**), App Bridge's fetch wrapper rejected with
  `TypeError: Failed to fetch`, and React Router turns a rejected action fetch into a **route
  error** → root ErrorBoundary → the branded 500 page inside the frame — while the server-side
  re-train had completed. Any transport failure (Wi-Fi blip, proxy, a 502 while the app restarts)
  produces the same page.
- **Fix** — `app/lib/clientAction.ts` `failClosedClientAction`: every child route with an `action`
  exports `clientAction = failClosedClientAction`, which wraps `serverAction()` and resolves a
  transport failure to `{ ok:false, error, transport:true }` (the routes' existing error toasts
  render it; thrown Responses / route error responses are re-thrown — Shopify's session-token
  bounce and redirects are untouched). The Connector page also revalidates on a transport failure
  so "Last trained" shows the real server state.
- **In-frame recovery** — `app/components/AppRouteError.tsx` `AppRouteBoundary`: every
  `app/routes/app.*.tsx` child route exports it as `ErrorBoundary`, so a loader-revalidation or
  render error shows a merchant-facing banner with **Try again** inside the app shell (NavMenu
  stays) instead of the root 500 document.
- **Tests** — `test/clientAction.test.ts` (rejection → fail-closed result with the submitted
  intent; Response / route error re-thrown; merchant-facing messages; wiring derived from the
  live route files — RED on the unwired routes), `test/appRouteError.test.ts` (SSR markup of the
  recovery banner).

## 2026-09-02 — fix: Connector 500 on Re-train (hydration mismatch) · host `store.busymate.ai`

Fixes a client-side "Something went wrong" 500 seen live when clicking **Re-train on my
store**. No code released a new Shopify version — server + client
code only.

- **Root cause** — a React **hydration mismatch**. Merchant timestamps were rendered during
  SSR with a bare `new Date(iso).toLocaleString()` (Connector "Last set up" / "Last trained",
  Conversations table, Billing trial-end). The Node host (UTC) and the merchant's browser
  (their own time zone) produced different text, so every embedded load threw React
  #418/#425/#423; inside the App Bridge iframe the hydration failure escalated to the root
  ErrorBoundary — the branded "Something went wrong" page — and the in-flight fetcher POST was
  aborted (nginx **499**). The action itself succeeded server-side; the host never returned a 500.
- **Fix** — `app/lib/formatTime.ts` (`formatServerTime`, UTC-pinned + deterministic) and
  `app/components/LocalTime.tsx` render the deterministic string on the server and the client's
  first paint (identical → clean hydration), then upgrade to the merchant's local time in a
  post-mount effect. All three routes now render `<LocalTime>`; `themeEmbed.formatTrainedAt`
  delegates to the shared formatter.
- **Fail-closed action** — `app/lib/connectorAction.server.ts` wraps the Connector action so a
  throwing re-train / re-provision resolves to `{ ok:false, error }` (an error toast) instead of
  throwing a 500 into the frame.
- **Tests** — `test/formatTime.test.ts` (deterministic + byte-identical across UTC / LA / Kolkata),
  `test/localTime.test.ts` (SSR markup == deterministic string), `test/connectorAction.test.ts`
  (the action never throws; fails closed).

## 2026-09-02 — main `0447ff3` → `ed2c9cc` → this · Shopify version **busymate-ai-5** · host `store.busymate.ai`

App Store resubmission (review reference 132497).

- **Billing (1.2.1)** — Shopify App Pricing is the only billing path: plan catalog ==
  `listing/pricing.json`, plan state from the Partner API `activeSubscription` +
  `?plan_handle=` redirect, App Events `ai_resolution` metering behind a secret-gated
  `POST /api/billing/meter` (hourly systemd timer on the host), honest plan cards.
- **Expiring offline tokens** — `@shopify/shopify-app-react-router` 2.1.0 with
  `future.expiringOfflineAccessTokens`; `Session.refreshToken` / `refreshTokenExpires`
  (encrypted at rest); background Admin calls refresh through `unauthenticated.admin`;
  `npm run tokens:cycle` cycled the 2 existing offline sessions on the host.
- **Grounded knowledge (auto-train)** — products / shop policies / pages →
  `publish_tenant_runtime.knowledge_sources` (`shopify:policies` / `shopify:products` /
  `shopify:pages`, ≤20,000 chars each, ≤40,000 total, deterministic truncation) at
  install, on product webhooks (debounced), on a scope grant and on "Re-train on my
  store"; training state on `ShopTenant` (`kb*` columns) shown on Home + Store
  connection; errors persisted and surfaced. New scope `read_legal_policies`.
- **Reinstall** — `provision_partner_tenant` `reactivated:true` → re-publish → Home "Live".
- **Onboarding / admin UX (5.1.3 / 5.1.5)** — setup checklist + theme-editor deep link,
  merchant Settings / Store connection / Conversations pages, branded error boundary,
  `/auth/login` never 500s, `/favicon.ico` + `/robots.txt`.
- **Knowledge = sellable products only** — DRAFT and ARCHIVED products no longer reach the
  assistant (seen live: "The Draft Snowboard — not published" listed to a shopper); they
  still count in the "N of M" training state. `npm run kb:retrain -- <shop>` re-trains from
  the shell through the same path as the merchant's button.
- **Platform companion (busymate-devtools supabase 750)** — the projected knowledge
  `updatedAt` is now Z-suffixed ISO; before it every trained tenant's `/support/<slug>`
  landing 404'd (widget "refused to connect") because v2's strict `z.iso.datetime()`
  rejected PostgREST's `+00:00` form. Trained stores were re-published after the fix.
- **In-app navigation** — Polaris `Link url` / `Button url` now route through React
  Router inside the admin iframe (`app/components/PolarisLink.tsx`); a raw anchor
  reloaded a bare URL the embedded auth could not serve.
- **App Proxy** — `/apps/busymate-ai/*` → `https://store.busymate.ai` (storefront identity).
- **Extension i18n** — launcher copy from `locales/*.json` (14 locales) + `t:` schema keys.
- **Listing + legal** — final listing copy ×14 in sync with the canonical store record
  (`npm run drift-check`), `docs/legal/{privacy,faq,terms}` rendered to
  `store.busymate.ai/legal/*` (nginx `/legal/terms` added).
- **Docs** — `docs/review/app-store-review-resolution.md` (1.2.1, expiring tokens,
  grounded knowledge, reinstall, App Proxy/identity, `/auth/login`, in-app navigation,
  scopes_update), SETUP §3b/§3c/§3c-bis/§3d/§11, CHECKLIST, README, CLAUDE.md.
- **CI** — workflows on Node 22 (`engines >=22`).

Shopify version busymate-ai-5 (Active, source `0447ff3`): scopes
`read_content,read_customers,read_fulfillments,read_legal_policies,read_orders,read_products,read_returns,write_orders,write_returns`,
App proxy `apps/busymate-ai → https://store.busymate.ai`, 6 webhook subscriptions,
theme extension `storefront-assistant`.
