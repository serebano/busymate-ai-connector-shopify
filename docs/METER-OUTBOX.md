# Prepared resolution delivery outbox

> **WIRED as of #19 (2026-09-13).** This module is no longer an
> unwired draft (PR #28 superseded — see `docs/BILLING.md` "Superseded: draft
> PR #28"). `app/lib/usageBilling.ts` (`liveMeterDeps().reportUsage`) now
> builds a `PreparedMeterBatch` from the real resolution producer
> (`app/lib/resolutionLedger.server.ts`) and the live Partner API billing
> cycle, and runs it through `prepare → claim → send → accept`. The caller
> contract below, written for the original unwired draft, still describes the
> core's own guarantees accurately — read `docs/BILLING.md` for how it is now
> invoked end to end (definition → producer → outbox → App Events → dead-letter).

Originally issue #27 shipped this as an **unwired foundation** (production
`meterShop` did not call it; the resolution read was still unavailable; no
Shopify request was ever sent). That historical framing below is kept for the
core's own design record.

## Caller contract

The future authenticated server-side adapter supplies a validated prepared batch:
shop and tenant identity, Shopify shop/subscription, paid plan, exact before/after
`BillingState.lastMeteredCursor` strings, eligible units, durable evidence reference,
ledger occurrence range, event timestamp and verified billing-cycle start/end.
The cursor strings include the app's serialized cycle counters, not just an
upstream cursor. The adapter must calculate them from the eligible ledger.

The core checks required values, positive safe integer units, a paid plan, and that
the occurrence range and timestamp fit one supplied cycle. It cannot independently
verify the evidence reference, Shopify shop GID, or actual Shopify cycle: the
adapter must establish those from trusted sources before preparation. Claiming
compares stored tenant, plan, subscription and cursor snapshots; it does not fetch
Shopify to revalidate a cycle transition or shop GID. The cursor-change test proves
only a stored cursor mismatch, not detection of a live Shopify cycle rollover. Never substitute processing time for ledger occurrence time. Mixed or
closed-cycle eligibility and changed subscription terms require explicit upstream
handling; they are not inferred here.

This is an internal module without an HTTP/MCP endpoint. Any future caller must
retain authenticated shop authorization and canonical tenant ownership checks.

## Delivery state

1. `prepare` locks the shop's billing and tenant rows. An existing pending batch
   wins over any new reader result. Otherwise the before-cursor, stored active subscription snapshot,
   plan and tenant must still match; the immutable batch is committed before any
   external request. A database trigger prevents payload/key identity changes.
2. `claim` grants one 30-second lease using the database clock. A second worker
   receives no claim until expiry. After expiry a retry uses the **same** persisted
   payload, timestamp and idempotency key. A timeout may leave the first network
   request running, so Shopify's idempotency remains necessary, not just the lease.
3. The future transport sends exactly the claimed payload. On refusal it can
   `release` its own lease. It must never generate a fresh timestamp/key on retry.
4. `accept` records **ingestion accepted**, not **billed**, and atomically advances
   the matching cursor. A failed transaction leaves both pending batch and original
   cursor intact. A newer claim rejects an older lease acknowledgment. If the shop
   snapshot changed after sending, the receipt becomes `reconciliation` and the
   cursor stays unchanged; that row blocks replacement batches.

Accepted receipts remain stored. A repeated preparation/acknowledgment cannot
advance twice. A reconciliation row needs an explicit, audited resolution path
before the module can be connected; automatic cancellation or rebilling is absent.
Retention of these receipts across uninstall and privacy lifecycle events must be
reviewed before production wiring (the current app-owned parent deletion cascades).

## Verification

- Full app migration chain applied to a separate PostgreSQL 16 database.
- Five real database scenarios passed: overlapping preparation, lease takeover and
  stale owner refusal, synthetic API acceptance followed by DB failure, plan change
  after sending, and tenant/cursor changes before sending. No Shopify calls made.
- Negative control removing the lease condition produced two simultaneous claims
  and failed the strict one-claim assertion; original source restored.
- 551 tests across 59 suites, typecheck, lint and production build passed.

The integration runner is `test/integration/meterOutbox.mjs`:
`node --import tsx test/integration/meterOutbox.mjs`. It accepts only a disposable
`postgresql` database named `outbox_27` at `127.0.0.1:55436`, verifies PostgreSQL 16,
and deletes only the synthetic shops it successfully created. It is deliberately
separate from credential-free unit tests and has no production fallback.

No deployment or real billing-processing proof is claimed. Shopify App Events
acceptance must ultimately be reconciled against processed billing evidence.
