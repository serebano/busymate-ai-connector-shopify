# September 13 resubmission record

Tracking: internal platform tracker
(verbatim reasons of the 2026-09-11 review, reference 132497).

## What the reviewer saw (screencasts, 2026-09-11)

- **5.1.2** — "Turn on the storefront assistant" opened the theme editor with the toast
  "App embed does not exist" and an empty App embeds panel (wrong `activateAppId`; fixed
  in 0.1.1 — the link now carries the app client id).
- **2.1.1** — Home showed "Assistant provisioned: Failed — publish_tenant_runtime:
  preflight failed … unmet scenarios: delegated-account-tool" after plan changes
  (fixed by 0.1.1 connector metadata + the platform's stale-slug reconciliation,
  live in ai 603).
- **4.5.4** — reminder to keep test credentials current (the app requires none; the
  instructions say so explicitly and the "no account required" option is set).

## Verified live on the review development store, 2026-09-13

- Home: Live, "Assistant provisioned: Done", trained on the store's products, policies
  and pages; Free plan active.
- Theme editor: App embeds lists "Busymate AI assistant" (enabled), no error toast; the
  preview storefront shows the "Ask us" launcher and the assistant answered "What is
  your refund policy?" from the store's own policy.
- One intermittent web 500 reproduced in the embedded app on "Refresh status"
  (`GET /app.data` → `AbortError`, client-aborted revalidation) — fixed in **0.1.8**
  (layout boundary recovers in-frame, Home loader parallelised, aborted requests not
  counted as 500s). Deployed to `store.busymate.ai` at `caf7bbb`; post-deploy Home
  renders Live and the refresh path no longer surfaces a 500 page.

## Not part of this resubmission

- Resolution metering (app issue #19) is a billing-accuracy
  program, not a review finding; the assistant is never switched off for billing.
