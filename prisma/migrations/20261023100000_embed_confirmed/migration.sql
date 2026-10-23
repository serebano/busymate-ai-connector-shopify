-- busymate-ai-src#2618 follow-up: the merchant's own confirmation that the app embed is on,
-- for a password-protected storefront the app cannot check from outside. Additive, nullable.
ALTER TABLE "ShopTenant" ADD COLUMN "embedConfirmedAt" TIMESTAMPTZ;
