# Architecture — Busymate AI for Shopify

> The app's AI backend **is Busymate AI**. Installing this app turns a Shopify store into
> **one Busymate AI white-label tenant**. This repo builds only the Shopify-specific
> layer; the multi-tenant agent, projection, connectors, delegation, handoff,
> 14-locale i18n and grounded knowledge base are the **live Busymate AI platform**,
> reached only through official MCP contracts.

## The one invariant: all-ops-via-MCP

This app **never** writes to the Busymate/Supabase DB or storage directly. Every
control-plane operation goes through an MCP tool or the connector protocol. If an
operation has no tool, the fix is to expose the tool on the Busymate AI side — not to reach around
it. (`app/bmai.server.ts` is the only module that talks to Busymate AI.)

## Components

| Piece | File(s) | Role |
|---|---|---|
| Embedded admin UI | `app/routes/app*.tsx` | Polaris + App Bridge merchant surface (status, settings, connector, billing) |
| Managed OAuth install | `app/shopify.server.ts`, `app/routes/auth.$.tsx` | Token exchange → offline access token in `Session` |
| Provision lifecycle | `app/bmai.server.ts` → `app/lib/provision.ts` | afterAuth → `provision_partner_tenant (reactivates on reinstall) → set_tenant_branding → add_tenant_embed_origin → register connector → build knowledge → publish_tenant_runtime (origins + knowledge_sources)` (idempotent) |
| Shopify Admin connector | `app/mcp/**`, route `app/routes/mcp.$.tsx` | The "just another connector row" runtime Busymate AI calls — JSON-RPC 2.0 + OAuth 2.1 discovery. `tools/call` is authenticated by HMAC-**verifying Busymate AI's HS256 actor token** (`app/mcp/actorToken.ts` + `app/mcp/auth.ts`): the per-(tenant,connector) secret is derived from a shared master, iss/aud/kid/ttl/claims are pinned, and the (tenant,connector) resolves the shop; fail-closed. Shopify Admin GraphQL then runs under the shop's offline token |
| Grounded knowledge (auto-train) | `app/lib/kbFetch.ts` · `app/lib/kbSnapshot.ts` · `app/lib/kbTrain.ts` · `app/lib/ingest.ts` | products + policies + pages → deterministic `knowledge_sources` within the platform limits → `publish_tenant_runtime`; at install, on product webhooks (debounced) and on "Re-train"; training state (`ShopTenant.kb*`) shown on Home / Store connection |
| Identified launch | `app/routes/identity.tsx`, `app/lib/identity.ts`, `.well-known/jwks.json` | App-Proxy-verified logged-in customer → short-lived ES256 launch JWT; JWKS = the tenant's visitor IdP |
| Storefront widget | `extensions/storefront-assistant/**` | Theme app-embed block mounting the Busymate AI embed (no `theme.liquid` edit) |
| Merchant billing | `app/routes/app.billing.tsx`, `app/lib/usageBilling.ts` | Shopify Billing usage charges, capped, never-disable-at-cap |
| GDPR + lifecycle webhooks | `app/routes/webhooks.*.tsx` | 3 mandatory compliance topics + `app/uninstalled` + `app/scopes_update` + KB freshness |
| App's own state | `prisma/schema.prisma` | `Session`, `ShopTenant`, `BillingState`, `LaunchKey` — a **dedicated** Postgres (independent failure domain, NOT Supabase) |

## The four access tiers (map 1:1 onto `mcp_connector_support_policies`)

- **public** — answer-from-KB + catalog reads, anonymous. No store-data writes.
- **identified** — `get_order_status`/`track_fulfillment`/`list_my_orders`, scoped
  to the launch-JWT customer subject.
- **delegated** — `create_refund`/`create_return`/`cancel_order`/`update_shipping_address`.
- **confirm** — the delegated writes require a confirm turn; the highest-risk ones
  are `adminOnly` so they stay off the free-text LLM path. A refund cap escalates
  above-cap requests to a human (`request_human` is LIVE).

## Delegation: actor-token verification (`app/mcp/auth.ts` + `app/mcp/actorToken.ts`)

Busymate AI mints a deliberately narrow, ≤5-minute **HS256 actor token** per delegated
`tools/call` and presents it as the MCP `Authorization: Bearer`. This host is
MULTI-TENANT, so it verifies as follows:

1. **Peek** the unverified `(tenant_id, connector_id)` from the token.
2. **Resolve the shop** — Prisma `ShopTenant` where `bmaiTenantId = tenant_id AND
   connectorId = connector_id`. No row ⇒ refuse.
3. **Derive + verify** — derive the per-(tenant,connector) secret from the shared
   `BMAI_SUPPORT_ACTOR_MASTER` (`HMAC-SHA256(master, "bmai-support-actor:v2\n" +
   tenantId + "\n" + connectorId)` — byte-for-byte identical to Busymate AI's signer), then
   HMAC-verify and pin `iss=https://busymate.ai`, `aud=<our /mcp origin>`,
   `kid=bmai-support-v2`, non-empty `sub`/`support_session_id`/`jti`, the numeric
   `iat`/`nbf`/`exp` window, and the ≤5-minute TTL. The tenant/connector are pinned
   by the SIGNATURE (the derivation), not a bare claim, so a token signed for one
   connector can never authenticate another.
4. **Verify visitor class** — signed `actor_kind` must be `anonymous` or `identified`.
   Only `identified` maps `sub` to `customerId`. An anonymous token retains its
   verified shop binding but has no customer identity and can invoke only public
   tools. Missing or unknown kinds are refused, including when legacy headers are
   enabled. The core producer always signs this claim.
5. **Verify confirmation** — only signed `confirmed: true` releases a confirmed
   call. Unsigned headers cannot promote it. Anonymous visitors remain blocked
   from customer/write tools even if their token carries confirmation.

FAIL-CLOSED: an unset/short master, a bad signature, any failed pin, or an unknown
`(tenant,connector)` ⇒ the caller is `null` and `tools/call` is refused. A token that
peeks as an actor token but fails to verify is NEVER downgraded to a header caller.
The legacy unverified `x-bmai-shop` header path is **dev/test only** (gated by
`BMAI_ALLOW_HEADER_CALLER`, OFF when `NODE_ENV=production`). `GET /api/bmai/status`
reports readiness (`actorVerifier`/`launchIdentity` booleans, no secret values).

## Install → live sequence

See `docs/PROVISIONING.md`. Summary: OAuth → offline token → MCP tenant lifecycle
→ register connector → auto-train → publish → projection worker → `<slug>.busymate.ai`
serves branded Busymate AI → theme extension injects the widget → identified launch scopes
order reads → resolved conversations meter to Shopify Billing + internal `usage_events`.

## Hosting

App server (admin UI + `/mcp` + `/identity` + JWKS) runs as a **systemd unit + nginx +
Let's Encrypt** at the app's public host (the official app serves at
`shopify.busymate.ai`). Reference unit + vhost are in [`deploy/`](../deploy). The theme
extension + app config deploy to Shopify's infra via `shopify app deploy`. Use a
dedicated Postgres and run `prisma migrate deploy` on release.

## Stack decision — React Router 7, NOT Remix

Remix merged into React Router v7; the official NEW-app template is
`Shopify/shopify-app-template-react-router` and `@shopify/shopify-app-react-router`
is the maintained package (`@shopify/shopify-app-remix` is maintenance-only). Admin API
+ webhooks are pinned to `api_version 2026-07`.
