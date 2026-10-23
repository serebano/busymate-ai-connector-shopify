-- busymate-ai-src#2624 walk: a training attempt that LOST ownership mid-run (the shop's tenant row
-- changed under it — e.g. the install lifecycle re-ran while the webhook worker trained) could not
-- settle (settle requires ownership) and so held its lease for the full 5 minutes. Every merchant
-- Re-train / Assistant settings publish in that window was refused. The token holder may always
-- give its OWN lease back: no ownership re-check (that is what failed), exact token + generation.
CREATE FUNCTION kb_reingest_release(p_shop TEXT,p_token TEXT,p_generation INTEGER) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE changed INTEGER;
BEGIN
 UPDATE "KbReingestQueue" SET
  "dueAt"=LEAST("dueAt",clock_timestamp()+interval '30 seconds'),
  "lastErrorCode"='lease_lost',
  "leaseToken"=NULL,"leaseGeneration"=NULL,"leaseTenantId"=NULL,"leaseUntil"=NULL,"updatedAt"=clock_timestamp()
 WHERE "shop"=p_shop AND "leaseToken"=p_token AND "leaseGeneration"=p_generation;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed=1 THEN PERFORM pg_notify('kb_reingest_wake',''); END IF;
 RETURN changed=1;
END $$;
