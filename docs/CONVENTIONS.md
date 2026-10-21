# Conventions — full text

The one-line rules in `CLAUDE.md` link here for the full text (moved verbatim).

## Connector tools are REAL

`app/mcp/tools/*` issue live Admin GraphQL (2026-07):
products (search/get/collections), orders scoped to the launch-JWT customer via
`orderLookup.ts` (a customer only sees their own orders), and the writes
refundCreate/returnCreate/orderCancel/orderUpdate/draftOrderCreate. The connector
registers `delegation_mode:'signed_actor_token'` + the delegated tools ONLY when the
host can verify the actor token (`BMAI_SUPPORT_ACTOR_MASTER` set == `/api/bmai/status`
`actorVerifier`); else it stays read-only `none`.

## Encryption at rest

Credential/PII columns (`Session.accessToken` + `email`,
`BmaiCredential.refreshToken`) are AES-256-GCM encrypted via `app/lib/fieldCipher.ts`
+ the `EncryptedSessionStorage` decorator; `APP_ENCRYPTION_KEY` in the host env
(unset ⇒ dev no-op; production sensitive writes require a valid key). See `docs/DATA-RETENTION.md`.

## Mgmt-call shape is shared

`set_tenant_branding` / `publish_tenant_runtime` args
are built ONLY by `app/lib/mgmtArgs.ts` (proof-of-shop + `confirm:true`), so
provisioning, the settings save and KB re-train can't drift out of the shape the
bmai edge verifies. The ONE knowledge write path is `knowledge_sources` (never the
old `kb_snapshot`, which the edge ignored).

## Grounded knowledge is deterministic and bounded

`app/lib/kbSnapshot.ts` compresses
products/policies/pages into ≤40 sources, ≤20,000 chars each, ≤40,000 total (policies →
products → pages, whole items, "+N more" note). Training state lives on `ShopTenant.kb*`
and is shown on Home / Store connection; ingest errors are persisted, never swallowed.

## Knowledge never goes stale silently (#52)

Webhooks first (products/*, shop/update,
scopes_update), committed to the app-owned durable queue before acknowledgement. A separate
knowledge worker retries leased jobs after restart; see `docs/ops/durable-retrain-design-2026-10.md`.
Shopify has no policy/page webhook, so `scripts/kb-freshness.ts` (k8s CronJob
`shopify-kb-freshness`, 4×/day) re-trains active shops older than 72 h and marks 404 (deleted) shops inactive;
`/api/kb/health` is 503 when an active shop is > 96 h or the backstop stopped finishing. Never
loosen the platform's 168 h preflight — the fix is fresh data. SETUP §3c-quater.

## Embedded-frame contract

Nothing may paint the root "500" document inside the admin
iframe. Every `app/routes/app.*.tsx` child route exports `ErrorBoundary = AppRouteBoundary`
(in-frame recovery with Try again) and, when it has an `action`,
`clientAction = failClosedClientAction` (a rejected action fetch — network blip, 502 while
restarting — resolves to `{ ok:false, error, transport:true }` and renders as an error toast).
Server actions fail closed too (`connectorAction.server.ts`); SSR timestamps go through
`<LocalTime>` / `formatServerTime` (deterministic → clean hydration). Enforced by
`test/clientAction.test.ts` (wiring derived from the live route files) + `test/formatTime.test.ts`.