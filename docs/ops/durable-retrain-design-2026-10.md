# Durable webhook retrain — implementation and rollout

Source implementation for the app-owned queue; **not deployed or activated**.
Production DDL and worker activation require the final owner window described
below. Local proofs do not establish production delivery or exactly-once effects.

## Behavior and ownership

Previously, products/shop/scopes routes acknowledged a Map/setTimeout timer. A
restart could lose that request. They now await authenticated, bound enqueue in
the app's own PostgreSQL database before returning 2xx. Persistence failure
propagates instead of reporting queued success. Orders remain a no-op.

`ShopTenant` supplies installation, inactive state and training outcomes.
`KbFreshnessRun` remains the fleet backstop ledger. The billing-only
`MeterDelivery` table and its immutable payload are untouched. Dedicated
`KbReingestQueue`, `KbReingestReceipt` and aggregate `KbReingestWorkerState`
tables preserve the separate ownership and acceptance meanings.

Receipt identity `(shop, webhookId)` deduplicates deliveries. No webhook payload,
customer/product content or credentials enter the queue. A new receipt advances
requested generation; a duplicate neither advances it nor postpones execution.
The quiet period is 20 seconds with a two-minute maximum burst deferral.
Missing ShopTenant binding refuses enqueue (non-2xx, sender can retry); an
existing unprovisioned binding retains pending work until published. Inactive
shops are deliberately skipped. Queue rows and receipts cascade on tenant purge.

Atomic SQL functions use database time, row locks and conditional token/generation
updates. A claim uses `FOR UPDATE SKIP LOCKED`; only one current lease can own a
shop. Completion clears only its claimed generation, preserving newer arrivals.
Expired/wrong tokens cannot renew, complete, release or postpone another lease.
Claims pin the tenant ID too: a changed binding invalidates ownership.

Webhook enqueue and cancellation have two-second lock/four-second statement
limits inside a bounded transaction. A lock/database failure prevents success
acknowledgement. Uninstall marks inactive and cancels generations atomically;
shop-not-found backstop handling also cancels pending jobs. GDPR deletion purges
the queue and receipt records. Successful retraining updates its training state
under the same tenant-first lock order, with lease ownership rechecked.

## Worker, retry and cancellation

`kb-reingest.ts` is a persistent owning systemd service. A dedicated authenticated
`pg` connection LISTENs on the app database; enqueue emits an empty NOTIFY only
on commit. The notification contains no shop or payload. Every notification and
every successful initial subscription/rejoin triggers an authoritative queue read.
Wakes coalesce while a drain runs; one local drain executes at a time. It drains
at most four jobs per batch and stops taking new work after four minutes per batch.

The 20-second quiet period (two-minute maximum burst deferral) is intentional
catalog coalescing, not a zero-latency promise. An exact due-time timer handles
that delay and persisted retries; a maximum 30-second fallback rereads durable
state even during listener reconnects. The listener reconnects with bounded
backoff and never treats a notification as proof of a queued or completed job.
`pg` uses the existing app DATABASE_URL, including its TLS parameters; deployment
must verify it is a direct/session connection compatible with LISTEN, not a
transaction pooler. No separate credentials or platform database are used.
The listener status is recorded value-blind; queue health refuses green while
it is disconnected even if the fallback still drains work.
Each attempt runs in a fresh owned child process with a 120-second deadline.
Lease renewal runs every 30 seconds; the lease lasts five minutes. Failed renewal
aborts that child. Cancellation sends SIGTERM, then SIGKILL to that same owned
child after two seconds if necessary, and waits for its exit before retry.
No historical or unrelated process is signalled.

The child verifies lease/active binding before fetching and immediately before
publishing. Retry persists a classified failure with exponential delay from five
seconds to 30 minutes; a job is never silently discarded after a retry count.
A crashed parent/host leaves an expiring lease that another worker can claim.
Manual retrain and the freshness backstop also use this queue/lease path, so they
cannot race a webhook attempt for the same shop. Installation's existing initial
publish remains part of provisioning; queue claims require a published binding.

The external publish is **at least once**: a response lost after a successful
publish can cause a repeat. The existing replace-by-key knowledge operation is
reused. A local nonce cannot fence an already accepted remote request, so this
change does not promise exactly-once publication or exclusion of every remote
in-flight replay. Child termination prevents subsequent local work but does not
undo a remote operation already accepted. No new publisher or direct platform
DB path is introduced.

Receipts older than 30 days are removed in batches of at most 1,000 per worker
run. A later duplicate can request another refresh, never erase newer work.
Pending queue rows remain until completion/cancellation or tenant purge.
`/api/kb/queue-health` exposes aggregate counts only and returns 503 for database
failure, missing/stale worker completion, a disconnected listener, failed pending work, expired leases,
or requests pending longer than ten minutes. Existing freshness health remains
separate; a healthy queue does not prove the 72-hour backstop ran.

## Required local and protected acceptance

- `npm ci`, `npx prisma generate`, typecheck, lint, all Vitest tests and production
  build against the final reviewed source. Full checks remain subject to the
  coordinator's resource admission; no bypass.
- `npm run test:reingest-sql`: exact committed migration functions in a new
  socket-only local PostgreSQL cluster, with a whitelisted environment and only
  synthetic rows. Includes receipt/restart, claim contention, duplicate receipt
  race, stale/expired nonce, tenant rebinding, newer generations, retries, cancellation
  and rollback. The real production pg listener sees committed notifications, no
  rolled-back notification, and reconnects/re-reads after a real database restart.
- Owning tests cover await-before-ack and refusal on persistence failure, public
  order no-op, worker renewal/timeout, actual owned-child termination/restart and
  aggregate health refusal. Interface/fake-port tests alone are not SQL proof.
- CI installs local PostgreSQL binaries and runs the same SQL fixture in the
  existing build-test job. No production URL or fixture is used.

## Concrete owner rollout window — approval required before execution

The captain must review this exact migration and final source/CI first:
`prisma/migrations/20261006053000_kb_reingest_queue/migration.sql`.
This is additive: three new empty tables, indexes, functions and one worker-state
row. It does not rewrite existing tenant rows. During the approved window:

1. Record the current host source SHA, successful service status and a recoverable
   database backup using the existing owning backup procedure. Retain the prior
   built artifact and dependency lockfile. Do not print DATABASE_URL or keys.
2. On `/opt/busymate-ai-shopify`, fetch the protected landed source and verify its
   ancestry. Inspect `npx prisma migrate status` through the existing protected
   app environment. **Hold if any pending migration other than the reviewed queue
   migration exists.** No blanket deploy of unknown schema changes.
3. Apply that verified pending set with the owning environment and deploy user:
   `npx prisma migrate deploy`. Record migration checksum/status. Verify table and
   function existence through bounded catalog reads, not merchant-row discovery.
4. Run the ordinary host rollout's `npm ci`, `npx prisma generate`, `npm run build`
   and application service restart on the same exact source. The app now commits
   queue requests; queued work can safely wait while the worker is installed.
5. Verify the existing DATABASE_URL is a direct/session PostgreSQL connection
   suitable for LISTEN, without printing it. Hold if it uses transaction pooling.
   Install the committed service into `/etc/systemd/system`, run
   `systemctl daemon-reload`, then
   `systemctl enable --now busymate-ai-shopify-kb-reingest.service`.
   EnvironmentFile stays `/etc/busymate-ai-shopify/env`; no new credentials/config
   values are required. The service uses KillMode=control-group, a 130-second
   stop ceiling and automatic restart. The active attempt has a 120-second bound;
   shutdown takes no further claims. Do not weaken the existing freshness timer.
6. Verify the service definition matches the committed file, its LISTEN session
   connected and an authoritative drain completed, `/api/bmai/status` succeeds and `/api/kb/queue-health` returns
   actual healthy aggregate evidence. No synthetic production webhook or merchant
   mutation is authorized by this runbook. Real delivery proof must use an
   explicitly authorized existing event/window and report its evidence separately.

Rollback: stop/disable only the new worker service, restore the previous source,
lockfile and built artifact using the ordinary app rollback, and restart the app.
**Retain all queue/receipt tables and pending work.** The old code can run with
additive tables present, but its new acknowledgements again have the old
process-local limitation; document that degraded state. Drain/reconcile retained
work with the reviewed worker after recovery. Never drop acknowledged rows or
reverse the migration just to make rollback look clean.

## Source validation record (not production acceptance)

The exact migration passes an isolated PostgreSQL restart/contention/rebind/purge
fixture, including the real production LISTEN client. Owning route, worker,
process, wake and health tests are run without production credentials. Full
Prisma generation, typecheck, lint, all tests and build still require the
coordinator's resource slot before this branch may be proposed as ready to ship.

The LISTEN client behavior follows the upstream [node-postgres Client API](https://node-postgres.com/apis/client).
