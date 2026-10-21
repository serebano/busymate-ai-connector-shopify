# Repo guide — busymate-ai-shopify

**Busymate AI for Shopify** — the official Shopify App Store app whose AI backend is the
Busymate AI white-label agent (**your mate**). Installing it turns a Shopify store into **one
Busymate AI tenant**. This is a **client** of the Busymate AI + Shopify plumbing, not a
new AI stack. It is also an **open reference** for connecting any platform to Busymate AI
(see [`docs/EXTENDING.md`](docs/EXTENDING.md)).

This file orients humans and AI coding assistants working in this repo. Contributor
workflow lives in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Reusable Codex guidance for this integration lives in
[`shopify-specialist`](.agents/skills/shopify-specialist/SKILL.md) (`$shopify-specialist`):
project contracts, browser diagnostics, delivery checks, and App Store review preparation.

## The one hard invariant — all-ops-via-MCP

This app reaches Busymate AI **only** through official contracts: the Busymate AI **MCP
tenant tools** (provision / publish / branding / usage), the **connector protocol** (MCP
JSON-RPC 2.0 + OAuth 2.1), and the white-label embed. **Never** a backdoor database or
storage write. If an operation has no MCP tool, expose the tool on the Busymate AI side —
don't reach around it. `app/bmai.server.ts` is the ONLY module that talks to Busymate AI.

## Stack

Shopify CLI 3 · **React Router 7** (`@shopify/shopify-app-react-router`, NOT Remix) ·
Polaris + App Bridge · Prisma + Postgres (the app's OWN DB) · theme app extension ·
Shopify Billing API · **`api_version 2026-07`** (Admin GraphQL).

## Layout

```
shopify.app.toml            app config: scopes, compliance_topics, webhooks, api_version
app/shopify.server.ts       shopifyApp(): managed auth + sessionStorage + afterAuth hook
app/bmai.server.ts          THE Busymate AI seam — MCP provision lifecycle + connector register + teardown
app/routes/app*.tsx         embedded admin UI (Polaris/App Bridge)
app/routes/webhooks.*.tsx   GDPR compliance (3) + app/uninstalled + scopes_update + KB freshness (products/*, shop/update)
app/routes/api.kb.health.tsx  knowledge-freshness health (503 on a >96 h shop or a silent backstop)
app/routes/mcp.$.tsx        the per-store Shopify Admin MCP connector transport
app/routes/identity.tsx     App-Proxy-verified logged-in customer → ES256 launch JWT
app/mcp/**                  connector: transport + auth (actor-token verify) + Admin GraphQL client + tools (real, 4 tiers)
app/lib/**                  tenantSlug · identity(JWKS) · storefrontIdentity · provision (lifecycle) · kbSnapshot/kbTrain/kbFetch/ingest/kbFreshness (grounded knowledge + the 72 h backstop) · plans/partnerApi/appEvents/usageBilling/billingGate (App Pricing) · themeEmbed · mgmtArgs · fieldCipher
extensions/storefront-assistant/  theme app-embed block mounting the widget (×14 locales)
prisma/schema.prisma        Session · ShopTenant · BillingState · LaunchKey · KbFreshnessRun …
docs/                       ARCHITECTURE · PROVISIONING · EXTENDING · LISTING
listing/                    localized-ready App Store copy (×14 plan)
CHECKLIST.md                Built-for-Shopify compliance status
```

## Conventions

- **Fail-closed** — an unverifiable delegation token, missing shop, or missing credential
  is a refusal, never an assumed success. No fake `{ok:true}`.
- **all-ops-via-MCP** — see the invariant above.
- **i18n-everywhere** — user-facing text is localized (extension locales + listing);
  no English-only surface.
- **Confirm-gate every write** connector tool; the highest-risk (refund/return/cancel) are
  `adminOnly` (kept off the free-text LLM path). A refund cap escalates above-cap → human.
- **Connector tools are REAL** — `app/mcp/tools/*` issue live Admin GraphQL; orders are scoped to the launch-JWT customer; delegated tools register ONLY when the host can verify the actor token, else read-only `none` ([CONVENTIONS](docs/CONVENTIONS.md#connector-tools-are-real)).
- **Encryption at rest** — credential/PII columns are AES-256-GCM encrypted via `app/lib/fieldCipher.ts`; production writes require `APP_ENCRYPTION_KEY` ([CONVENTIONS](docs/CONVENTIONS.md#encryption-at-rest), `docs/DATA-RETENTION.md`).
- **Mgmt-call shape is shared** — `set_tenant_branding` / `publish_tenant_runtime` args are built ONLY by `app/lib/mgmtArgs.ts`; the ONE knowledge write path is `knowledge_sources` ([CONVENTIONS](docs/CONVENTIONS.md#mgmt-call-shape-is-shared)).
- **Grounded knowledge is deterministic and bounded** — `app/lib/kbSnapshot.ts`: <=40 sources, <=20,000 chars each, <=40,000 total; ingest errors persisted, never swallowed ([CONVENTIONS](docs/CONVENTIONS.md#grounded-knowledge-is-deterministic-and-bounded)).
- **Knowledge never goes stale silently (#52)** — webhooks first (durable queue), `shopify-kb-freshness` CronJob backstop at 72 h, `/api/kb/health` 503 at >96 h; never loosen the platform's 168 h preflight ([CONVENTIONS](docs/CONVENTIONS.md#knowledge-never-goes-stale-silently-52), SETUP §3c-quater).
- **Public naming** — merchant- and customer-facing copy says **"Busymate AI"** / **"your mate"**,
  never internal codenames. Enforced by `test/naming.test.ts`.
- **Embedded-frame contract** — nothing paints the root "500" in the admin iframe: every `app.*.tsx` child route exports `ErrorBoundary = AppRouteBoundary` and (with an `action`) `clientAction = failClosedClientAction`; enforced by `test/clientAction.test.ts` ([CONVENTIONS](docs/CONVENTIONS.md#embedded-frame-contract)).
- **Every change ships a test** — `test/**`, `npm test`. Assert the denied/failure path too.

## Commands

`npm run dev` (shopify app dev · needs Partner auth) · `npm test` · `npm run typecheck`
· `npm run lint` · `npm run build` · `npm run deploy` (shopify app deploy) ·
`npx prisma migrate deploy`.

## Owner/deploy-gated (cannot be done from a code session)

Create the Partner app (client_id/secret), the Busymate AI provisioning credential, the
app host (k8s, SETUP §3b) + DNS + TLS, the ES256 launch key, the billing plan, and the listing
assets/translations. See [`SETUP.md`](SETUP.md) and [`CHECKLIST.md`](CHECKLIST.md).
