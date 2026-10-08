-- App-owned credential journal: an unresolved remote grant is never replayed.
ALTER TABLE "BmaiCredential" ADD COLUMN "refreshPendingAt" TIMESTAMPTZ;
