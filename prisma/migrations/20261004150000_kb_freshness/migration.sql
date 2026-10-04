-- Knowledge freshness (#52): inactive marker on ShopTenant (uninstalled / deleted
-- store — never re-trained) + the backstop run ledger. Additive only.
ALTER TABLE "ShopTenant" ADD COLUMN "inactiveAt" TIMESTAMPTZ;
ALTER TABLE "ShopTenant" ADD COLUMN "inactiveReason" TEXT;

CREATE TABLE "KbFreshnessRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'timer',
    "startedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ,
    "ok" BOOLEAN,
    "considered" INTEGER,
    "active" INTEGER,
    "due" INTEGER,
    "trained" INTEGER,
    "failed" INTEGER,
    "inactivated" INTEGER,
    "skipped" INTEGER,
    "deferred" INTEGER,
    "detail" JSONB,

    CONSTRAINT "KbFreshnessRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KbFreshnessRun_finishedAt_idx" ON "KbFreshnessRun"("finishedAt");
