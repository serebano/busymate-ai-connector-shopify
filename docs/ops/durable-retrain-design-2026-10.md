# Durable webhook retrain design

Status: prepared boundary only. `reingestQueue.ts` is not imported by the active
webhook routes. The current process-local scheduler is still in production.
No migration, database write, worker activation or configuration change has been
performed as part of this design.

## Current contracts and reuse

Authenticated products/shop/scopes routes call `scheduleReingest` and return 2xx
before the Map/setTimeout scheduler performs work. A restart loses that timer.
The 6-hour freshness timer eventually retries stores older than 72 hours, which
does not preserve the meaning of an acknowledged webhook.

`ShopTenant` supplies installed/inactive state and training outcomes.
`KbFreshnessRun` is a fleet-run history and health ledger, not an event queue.
`MeterDelivery` is an unwired billing outbox with a BillingState foreign key,
immutable billing payload and billing-specific reconciliation; do not reuse its
rows or loosen those invariants. Reuse its transaction/nonce compare-and-set
pattern, the existing app database, `retrainNow`/`trainTenant`, webhook HMAC
helper, and the existing systemd deployment conventions.

## Proposed persistence

A dedicated `KbReingestQueue` row per shop should hold requested/completed
monotonic generations, due time, attempt count, last classified failure,
lease token, claimed generation and lease expiry. A separate
`KbReingestReceipt` unique `(shop, webhookId)` records duplicate deliveries
without storing raw webhook payload, credentials or product/customer content.
Retain receipts for a documented horizon exceeding the verified Shopify retry
window; a later duplicate can safely request a redundant retrain, not overwrite
newer pending work. Receipt retention and queue history need bounded cleanup.

The live adapter must implement the `DurableReingestStore` contracts against
PostgreSQL with its clock and transactional row locks. No read-then-write lease
without a conditional UPDATE. The enqueue transaction must lock/check ShopTenant
active state, deduplicate the receipt, then advance requested generation for a
new event. COMMIT must precede 2xx. Database errors must return non-2xx so the
sender can retry. No memory-only fallback.

A burst extends the quiet-period due time, bounded by a maximum deferral so a
busy store cannot starve forever. A duplicate receipt does not advance generation
or postpone due time. Missing/unprovisioned shops need an explicit durable
pending disposition rather than silently dropping an authenticated early event.
Inactive/suspended stores are a deliberate refusal.

## Worker and failure semantics

- A bounded worker claims due rows with `FOR UPDATE SKIP LOCKED` and excludes
  inactive shops and unexpired leases. Persist a fresh random token and the
  claimed generation. Concurrency remains bounded per host and per shop.
- Renew leases only when the exact token/generation is still unexpired. An
  expired worker never revives its old token. Failed renewal aborts subsequent
  work; verify ownership and active-shop state again immediately before publish.
- Complete with exact token/generation CAS and DB-clock expiry checks. Mark only
  the claimed generation complete. An event arriving during a run leaves a new
  pending generation; stale completion/retry must not erase or postpone it.
- Persist retry classification and exponential delay (5 seconds, capped at
  30 minutes). Do not discard a job after a fixed retry count. Repeated failures
  become an operator-visible alert. Authentication/inactive failures require
  distinct handling from temporary transport/rate-limit failures.
- Uninstall must durably mark inactive and invalidate/cancel pending work in one
  transaction, before acknowledgement. Reinstall invalidates old leases and
  establishes a new generation. GDPR shop-redact deletes this app-owned queue
  and receipts with the store's data.
- Restart recovery comes from scanning durable due/expired rows, never from
  process timers. The worker must run independently of incoming web traffic.
  Keep the existing freshness timer as a backstop, coordinated through the same
  per-shop training exclusion rather than racing a webhook worker.

The remote publish remains **at least once**. Local lease ownership cannot prove
exactly-once remote effects after a response is lost or a process pauses during
an in-flight request. Before activation, verify the platform's replace-by-key
training behavior and establish a publish idempotency/revision-fencing strategy
or document the remaining replay/stale-publish constraint. Every external call
needs a bounded timeout/abort path; abandoning a Promise alone is not cancellation.

## Source integration still required

1. Add reviewed schema/migration and Prisma adapter, with an isolated PostgreSQL
   suite proving real transaction contention, duplicate delivery, rollback,
   restart, lease expiry, stale token, in-flight generations and cancellation.
2. Change all authenticated KB/scopes webhook callers to await durable enqueue
   and carry verified webhookId. Preserve order no-op. Update async scope and
   uninstall callers and prove enqueue failure cannot produce 2xx.
3. Add a bounded worker entrypoint and owning systemd unit/timer. Bind training
   cancellation/lease checking through the existing train/publish seam. Do not
   introduce a second knowledge publisher or reuse a billing producer.
4. Expose aggregate queue health (oldest pending age, expired leases, retry/failure
   counts and last completed worker run); an empty/stale heartbeat is not green.
5. Normal app checks plus isolated database and restart/process-boundary proof.
   Interface/fake-port tests alone do not demonstrate durability.

## Required owner rollout window

Before production mutations, the captain must review the exact migration,
backup/recovery instructions, measured table/index cost, compatible code order,
worker resource budget and rollback steps. Apply an additive migration first,
verify schema provenance without customer-row scans, deploy reviewed code, then
activate the worker with an explicit owner window. Use a synthetic local queue
for restart tests; no production webhook fixtures or merchant writes without
separate authorization. Capture actual migration/deployed source and aggregate
health evidence. Rollback may disable the worker and restore prior code while
retaining queued rows; never drop acknowledged work to make rollback appear clean.

The current commit deliberately changes none of those production surfaces.
