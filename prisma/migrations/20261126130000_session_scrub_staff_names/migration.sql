-- Data minimisation: the staff first/last name carried by Shopify online sessions is never read by this
-- app, and is no longer written (app/lib/encryptedSessionStorage.ts). Scrub the rows stored before that.
UPDATE "Session" SET "firstName" = NULL, "lastName" = NULL WHERE "firstName" IS NOT NULL OR "lastName" IS NOT NULL;
