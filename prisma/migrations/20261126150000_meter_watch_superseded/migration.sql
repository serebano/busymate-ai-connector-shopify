-- Usage metering watch (docs/BILLING.md "Never counted twice", "Holds and alerts").
-- Additive: per-shop hold/mismatch bookkeeping + the open operator alert, kept OUT of
-- lastMeteredCursor (the outbox's snapshot identity), and a 'superseded' delivery state so a
-- newer batch replaces an unclaimed older pending one (sends are keyed by cumulative position,
-- so replacing a row can never add units twice at Shopify).
ALTER TABLE "BillingState" ADD COLUMN "meterWatch" JSONB;
ALTER TABLE "BillingState" ADD COLUMN "meterAlert" TEXT;
ALTER TABLE "BillingState" ADD COLUMN "meterAlertAt" TIMESTAMPTZ;

ALTER TABLE "MeterDelivery" DROP CONSTRAINT "MeterDelivery_state_check";
ALTER TABLE "MeterDelivery" ADD CONSTRAINT "MeterDelivery_state_check"
  CHECK ("state" IN ('pending','accepted','reconciliation','superseded'));
DROP INDEX "MeterDelivery_one_pending_shop";
CREATE UNIQUE INDEX "MeterDelivery_one_pending_shop" ON "MeterDelivery"("shop")
  WHERE "state" NOT IN ('accepted','superseded');
