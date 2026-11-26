# Provisioning — install → live

Every step runs through **Busymate AI MCP tools** (all-ops-via-MCP). `app/bmai.server.ts`
is the single integration seam. Idempotent: safe to re-run on every re-auth.

## Sequence

1. **Merchant clicks Install** → Shopify managed OAuth → the app stores the
   **offline access token** (`Session`, Prisma). `hooks.afterAuth` fires.
2. **Provision the tenant** — `provision_partner_tenant({ partner:"shopify", shop, slug, proof })`.
   - The store becomes an `is_platform=false` tenant. `slug` = `shopToSlug(shop)`
     (`app/lib/tenantSlug.ts`), giving the serving host `<slug>.busymate.ai` off the
     platform apex cert — **no per-store DNS/cert**.
3. **Branding** — `set_tenant_branding` (proof-of-shop + `branding:{…}` + confirm;
   built by `app/lib/mgmtArgs.ts`, refined in `app/routes/app.settings.tsx`).
4. **Embed origins** — `add_tenant_embed_origin([ https://<shop>.myshopify.com,
   custom domain ])` (proof path). The tenant serves at the derived slug lane
   `<slug>.busymate.ai` (no operator-only `set_tenant_domain`); the storefront origins
   go into the tenant's **published embed-origin allowlist** (checked by `embed/v1.js`),
   NOT `tenant_domains`.
5. **Merchant admin** — NOT called at install: `add_tenant_admin` needs a bmai
   `user_id` a Shopify install lacks; the merchant is linked on first bmai sign-in.
6. **Register the Shopify Admin connector** — `upsert_tenant_support_connector` with
   `endpoint = https://store.busymate.ai/mcp`, `auth_mode:'none'`, and
   `delegation_mode:'signed_actor_token'` + the delegated write tools when the actor
   verifier is ready (`BMAI_SUPPORT_ACTOR_MASTER` set), else read-only `none`; the
   four-tier `mcp_connector_support_policies`.
7. **Train** — `app/lib/kbFetch.ts` reads the store's products, shop policies and pages
   (Admin GraphQL; `read_products` / `read_legal_policies` / `read_content`) and
   `app/lib/kbSnapshot.ts` compresses them deterministically into the platform's
   `knowledge_sources` shape (≤40 sources, ≤20,000 chars each, ≤40,000 total; policies →
   products → pages, whole items, "+N more" note when trimmed). A failure here is
   recorded as `kbError` (surfaced on Home / Store connection) — it never blocks step 8.
8. **Publish** — ONE `publish_tenant_runtime` carrying the launch/embed origins AND the
   `knowledge_sources` (draft → preflight → publish, server-side). The projection worker
   delivers → the tenant goes LIVE, **trained**. The training state (`kbTrainedAt`,
   counts, `kbError`) is persisted on `ShopTenant`. Re-training: product webhooks
   (`webhooks.kb.products.tsx`, debounced per shop) and **Store connection → Re-train**
   (`app/lib/ingest.ts` → `app/lib/kbTrain.ts`) run the same fetch → compress → publish
   with the same origins.
9. **Widget** — the theme app extension injects `/embed/v1.js data-assistant=<slug>`;
   logged-in customers get identified launch (App Proxy `logged_in_customer_id` →
   `/identity` mints the ES256 launch JWT).
10. **Metering** — resolved conversations → Shopify Billing usage charge (capped) +
    internal `usage_events`.

## The provisioning-credential gap (OWNER-GATED)

`provision_tenant` (creating a NEW tenant) is a **platform-operator** action; a
tenant-admin cannot mint one. So the Shopify app cannot self-provision with only
merchant credentials. Two paths:

- **Recommended:** build a Busymate AI **`provision_partner_tenant`** MCP tool gated by
  *proof-of-shop* (a verified Shopify shop signature) → self-serve, no shared
  operator secret. (This lives on the Busymate AI side.)
- **Fallback:** the app holds a dedicated, narrowly-scoped operator/service OAuth
  client that can ONLY provision + wire branding/domain/admin/connector.

Until the credential exists, `callMcpTool` returns `{ ok:false, error }` and the
lifecycle records `provisionState:"error"` — it **does not fake success**
(green-while-dead is a bounce-able anti-pattern). The install is retryable from
**Connector & data → Re-provision**.

## Teardown + reinstall

- `app/uninstalled` → `suspend_tenant` (the tenant is ARCHIVED on the platform) + purge
  sessions (soft; keeps data 48h).
- **Reinstall** → the lifecycle re-runs: `provision_partner_tenant` REACTIVATES the
  archived tenant under the proof-of-shop (`reactivated: true`), the runtime is
  re-published (origins + knowledge) and the app records `published` — Home shows Live.
- `shop/redact` (GDPR, 48h later) → `delete_tenant` + purge all local state.
