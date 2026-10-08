-- Additive app-owned queue. No raw webhook payload or credentials are stored.
CREATE TABLE "KbReingestQueue" (
 "shop" TEXT PRIMARY KEY REFERENCES "ShopTenant"("shop") ON DELETE CASCADE,
 "requested" INTEGER NOT NULL DEFAULT 0,
 "completed" INTEGER NOT NULL DEFAULT 0,
 "dueAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "firstPendingAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "leaseToken" TEXT,
 "leaseGeneration" INTEGER,
 "leaseTenantId" TEXT,
 "leaseUntil" TIMESTAMPTZ,
 "lastErrorCode" TEXT,
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("completed" <= "requested" AND "completed">=0 AND "attempts">=0),
 CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL)),
 CHECK (("leaseToken" IS NULL) = ("leaseGeneration" IS NULL)),
 CHECK (("leaseToken" IS NULL) = ("leaseTenantId" IS NULL))
);
CREATE INDEX "KbReingestQueue_dueAt_idx" ON "KbReingestQueue"("dueAt");
CREATE TABLE "KbReingestReceipt" (
 "shop" TEXT NOT NULL REFERENCES "KbReingestQueue"("shop") ON DELETE CASCADE,
 "webhookId" TEXT NOT NULL,
 "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("shop","webhookId")
);
CREATE INDEX "KbReingestReceipt_receivedAt_idx" ON "KbReingestReceipt"("receivedAt");

CREATE FUNCTION kb_reingest_enqueue(p_shop TEXT,p_webhook TEXT,p_immediate BOOLEAN DEFAULT false) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE t RECORD; q RECORD; inserted INTEGER;
BEGIN
 IF p_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' OR length(trim(p_webhook))=0 OR length(p_webhook)>200 THEN RAISE EXCEPTION 'invalid webhook binding'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_shop,1429));
 SELECT * INTO t FROM "ShopTenant" WHERE "shop"=p_shop FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'shop binding unavailable'; END IF;
 IF (t."inactiveAt" IS NOT NULL OR t."provisionState"='suspended') THEN RETURN 'inactive'; END IF;
 INSERT INTO "KbReingestQueue"("shop") VALUES(p_shop) ON CONFLICT DO NOTHING;
 SELECT * INTO q FROM "KbReingestQueue" WHERE "shop"=p_shop FOR UPDATE;
 INSERT INTO "KbReingestReceipt"("shop","webhookId") VALUES(p_shop,p_webhook) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted=0 THEN RETURN 'duplicate'; END IF;
 UPDATE "KbReingestQueue" SET
  "requested"="requested"+1,
  "firstPendingAt"=CASE WHEN "requested"="completed" THEN clock_timestamp() ELSE "firstPendingAt" END,
  "dueAt"=LEAST(clock_timestamp()+CASE WHEN p_immediate THEN interval '0 seconds' ELSE interval '20 seconds' END,CASE WHEN "requested"="completed" THEN clock_timestamp()+interval '2 minutes' ELSE "firstPendingAt"+interval '2 minutes' END),
  "updatedAt"=clock_timestamp()
 WHERE "shop"=p_shop;
 PERFORM pg_notify('kb_reingest_wake',''); -- Delivered only after the enclosing commit.
 RETURN 'enqueued';
END $$;

CREATE FUNCTION kb_reingest_claim(p_token TEXT,p_shop TEXT DEFAULT NULL) RETURNS SETOF "KbReingestQueue" LANGUAGE plpgsql AS $$
DECLARE selected TEXT;
BEGIN
 IF length(p_token)<20 THEN RAISE EXCEPTION 'claim token required'; END IF;
 SELECT q."shop" INTO selected FROM "KbReingestQueue" q
 WHERE q."requested">q."completed" AND q."dueAt"<=clock_timestamp() AND (p_shop IS NULL OR q."shop"=p_shop)
 AND (q."leaseUntil" IS NULL OR q."leaseUntil"<=clock_timestamp())
 AND EXISTS(SELECT 1 FROM "ShopTenant" t WHERE t."shop"=q."shop" AND t."inactiveAt" IS NULL AND t."provisionState"='published' AND t."bmaiTenantId" IS NOT NULL)
 ORDER BY q."dueAt",q."shop" FOR UPDATE SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN; END IF;
 RETURN QUERY UPDATE "KbReingestQueue" SET "leaseToken"=p_token,"leaseGeneration"="requested","leaseTenantId"=(SELECT "bmaiTenantId" FROM "ShopTenant" WHERE "shop"=selected),
  "leaseUntil"=clock_timestamp()+interval '5 minutes',"attempts"="attempts"+1,"updatedAt"=clock_timestamp()
 WHERE "shop"=selected RETURNING *;
END $$;

CREATE FUNCTION kb_reingest_owns(p_shop TEXT,p_token TEXT,p_generation INTEGER) RETURNS BOOLEAN LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM "KbReingestQueue" q JOIN "ShopTenant" t USING("shop")
 WHERE q."shop"=p_shop AND q."leaseToken"=p_token AND q."leaseGeneration"=p_generation
 AND q."leaseUntil">clock_timestamp() AND q."leaseTenantId"=t."bmaiTenantId" AND t."inactiveAt" IS NULL AND t."provisionState"='published' AND t."bmaiTenantId" IS NOT NULL)
$$;

CREATE FUNCTION kb_reingest_renew(p_shop TEXT,p_token TEXT,p_generation INTEGER) RETURNS SETOF "KbReingestQueue" LANGUAGE sql AS $$
 UPDATE "KbReingestQueue" SET "leaseUntil"=clock_timestamp()+interval '5 minutes',"updatedAt"=clock_timestamp()
 WHERE "shop"=p_shop AND "leaseToken"=p_token AND "leaseGeneration"=p_generation AND "leaseUntil">clock_timestamp() AND kb_reingest_owns(p_shop,p_token,p_generation) RETURNING *
$$;

CREATE FUNCTION kb_reingest_settle(p_shop TEXT,p_token TEXT,p_generation INTEGER,p_ok BOOLEAN,p_delay INTEGER,p_code TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE changed INTEGER;
BEGIN
 IF p_delay<0 OR p_delay>1800000 OR p_code !~ '^[a-z_]{1,40}$' THEN RAISE EXCEPTION 'invalid retry metadata'; END IF;
 UPDATE "KbReingestQueue" SET
  "completed"=CASE WHEN p_ok THEN p_generation ELSE "completed" END,
  "dueAt"=CASE WHEN p_ok THEN "dueAt" WHEN "requested">p_generation THEN LEAST("dueAt",clock_timestamp()+p_delay*interval '1 millisecond') ELSE clock_timestamp()+p_delay*interval '1 millisecond' END,
  "attempts"=CASE WHEN p_ok THEN 0 ELSE "attempts" END,
  "lastErrorCode"=CASE WHEN p_ok THEN NULL ELSE p_code END,
  "leaseToken"=NULL,"leaseGeneration"=NULL,"leaseTenantId"=NULL,"leaseUntil"=NULL,"updatedAt"=clock_timestamp()
 WHERE "shop"=p_shop AND "leaseToken"=p_token AND "leaseGeneration"=p_generation AND "leaseUntil">clock_timestamp() AND kb_reingest_owns(p_shop,p_token,p_generation);
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed=1 THEN PERFORM pg_notify('kb_reingest_wake',''); END IF;
 RETURN changed=1;
END $$;

CREATE FUNCTION kb_reingest_cancel(p_shop TEXT,p_reason TEXT DEFAULT 'uninstalled') RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF p_reason NOT IN ('uninstalled','shop_not_found') THEN RAISE EXCEPTION 'invalid inactive reason'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_shop,1429));
 UPDATE "ShopTenant" SET "inactiveAt"=clock_timestamp(),"inactiveReason"=p_reason,"provisionState"=CASE WHEN p_reason='uninstalled' THEN 'suspended' ELSE "provisionState" END WHERE "shop"=p_shop;
 UPDATE "KbReingestQueue" SET "completed"="requested","attempts"=0,"leaseToken"=NULL,"leaseGeneration"=NULL,"leaseTenantId"=NULL,"leaseUntil"=NULL,"lastErrorCode"=NULL,"updatedAt"=clock_timestamp() WHERE "shop"=p_shop;
END $$;

CREATE TABLE "KbReingestWorkerState" (
 "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id"=1),
 "listenerConnected" BOOLEAN NOT NULL DEFAULT false,
 "startedAt" TIMESTAMPTZ,
 "finishedAt" TIMESTAMPTZ,
 "claimed" INTEGER NOT NULL DEFAULT 0,
 "failed" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "KbReingestWorkerState"("id") VALUES(1);
