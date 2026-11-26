-- ECO-03: single-use actor credential ids. A `bmai.actor/3` token (and the guest binding)
-- authorizes ONE tools/call; its jti is burned here before any side effect, so a replay on
-- any replica is refused. Rows are dead after exp + clock skew and are swept opportunistically.
CREATE TABLE "ActorJti" (
    "key" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "ActorJti_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "ActorJti_expiresAt_idx" ON "ActorJti"("expiresAt");
