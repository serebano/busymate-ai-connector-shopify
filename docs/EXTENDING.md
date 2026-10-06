# Extending it — connect your own platform to Busymate AI

This app is the **Shopify worked example** of a general pattern. Busymate AI is a
universal, multi-tenant, white-label AI: any platform integrates with it through the
same **six steps**, entirely over official contracts (an MCP tool surface + a connector
protocol). To support a new platform — Stripe, WordPress, BigCommerce, a bespoke SaaS —
you **reimplement the platform-specific left column and reuse the Busymate AI right
column**.

> **The one invariant: all-ops-via-MCP.** Your integration reaches Busymate AI only
> through MCP tools and the connector protocol — never a direct database or storage
> write. Keep a single seam module (here, `app/bmai.server.ts`) as the only place that
> talks to Busymate AI. If an operation has no tool, the fix is to expose the tool on
> the Busymate AI side, not to reach around the contract.

## The six steps in detail

### a. Provision a tenant (proof-of-origin gated)

One Busymate AI tenant per platform account. Provisioning is a privileged action, so it
is authorized by a **proof-of-origin** signature rather than a shared operator secret:
your app signs `(partner, account, timestamp)` with a secret shared with Busymate AI, and
the `provision_partner_tenant` tool verifies it.

- **Shopify example:** `app/lib/provision.ts` + `app/lib/partnerProof.ts` sign the shop
  domain; the tenant serves at the derived slug `<slug>.busymate.ai`.
- **Your platform:** replace "shop domain" with your account identifier (a Stripe
  account id, a WordPress site URL, a workspace id). Everything downstream is identical.

### b. Brand, allow embedding, and publish

- `set_tenant_branding` — product name, logo, theme colors.
- `add_tenant_embed_origin` — the origins allowed to `iframe`-embed the widget (your
  storefront/app URLs). This is an allowlist, distinct from the tenant's serving host.
- `publish_tenant_runtime` — compiles + publishes the runtime projection; the tenant
  goes live at `<slug>.busymate.ai`.

Reused verbatim across platforms. See `app/lib/provision.ts::runProvisionLifecycle`.

### c. Register a support connector (so your mate can act)

Your platform's tools (look up an order, issue a refund, cancel a subscription…) are
exposed as a **connector**: an MCP JSON-RPC endpoint you host, registered with
`upsert_tenant_support_connector`. Busymate AI calls it when the assistant needs to act.

Every tool is gated by a **tier** and, for writes, a **confirm** turn + optional **cap**:

- **public** — answer-from-knowledge-base + catalog reads, anonymous.
- **identified** — reads scoped to the launch-JWT subject (this account's orders).
- **delegated** — writes (refund, cancel, address change).
- **confirm** — delegated writes require an explicit confirm; the highest-risk ones are
  `adminOnly` (kept off the free-text LLM path). A spend cap escalates above-cap requests
  to a human.

- **Shopify example:** `app/mcp/*` (transport + auth) and `app/mcp/tools/*` (the Admin
  GraphQL-backed tools). Delegated calls are authorized by verifying a signed actor token
  (below).
- **Your platform:** keep `app/mcp/route.ts`, `app/mcp/auth.ts`, `app/mcp/actorToken.ts`,
  and the registry/gating in `app/mcp/tools/registry.ts`; replace only the tool bodies in
  `app/mcp/tools/*` with calls to your platform's API.

### d. Embed the chat widget

A single script tag mounts the white-label widget; there is no core-template edit:

```html
<script src="https://busymate.ai/embed/v1.js"
        data-assistant="<slug>"
        data-origin="https://busymate.ai" defer></script>
```

The `iframe` needs `allow="microphone"` for voice. On Shopify this ships as a **theme app
extension** (`extensions/storefront-assistant/`); on another platform, inject the same
script however that platform allows (a plugin, a snippet, a layout partial).

### e. Identified launch (know your visitor)

So your mate can scope answers and actions to a real account, the app proves the visitor's
identity with a short-lived **ES256 JWT**: the private key signs a launch token; the
public half is served at `/.well-known/jwks.json` and registered as the tenant's visitor
identity provider.

- **Shopify example:** `app/routes/identity.tsx` verifies the App Proxy HMAC to trust
  `logged_in_customer_id`, then `app/lib/identity.ts` mints the launch JWT.
- **Your platform:** replace the App-Proxy verification with your own session check
  (a signed cookie, an OIDC id-token, your session store); the JWT mint + JWKS are
  identical.

### f. Compliance seams

Wire your platform's lifecycle + privacy events to the Busymate AI effects:

- data export request → `export_tenant_customer_data`
- erase request → `redact_tenant_customer`
- account disconnect → `suspend_tenant`
- hard delete → `delete_tenant`

- **Shopify example:** `app/routes/webhooks.compliance.tsx` + `app/lib/compliance.ts`
  (the three mandatory GDPR topics) and `app/routes/webhooks.app.uninstalled.tsx`.
- **Your platform:** call the same effects from your webhooks/cron.

## A concrete port (checklist)

To stand up, say, a **WordPress/WooCommerce** integration:

1. **Auth & install** — replace Shopify managed OAuth with your platform's app-install
   flow; store the resulting access token in the app's own DB (`prisma/schema.prisma`).
2. **Provision** — keep `runProvisionLifecycle`; feed it your account id + a proof-of-
   origin signature (`app/lib/partnerProof.ts` pattern) instead of the shop domain.
3. **Connector tools** — keep `app/mcp/*`; rewrite `app/mcp/tools/*` to call the WooCommerce
   REST API. Keep the same tool names/tiers or adjust `registry.ts`.
4. **Widget** — ship the embed `<script>` as a WordPress plugin/shortcode instead of a
   theme app extension.
5. **Identity** — verify the logged-in WordPress user (nonce/cookie) in place of the App
   Proxy HMAC, then mint the same launch JWT.
6. **Compliance** — call the export/redact/teardown effects from WordPress privacy hooks.
7. **Billing** — use your platform's billing, or drop `app/lib/usageBilling.ts` entirely.

Everything under `app/lib/provision.ts`, `app/lib/bmaiToken.ts`, `app/lib/connector.ts`,
`app/lib/identity.ts`, and `app/mcp/{route,auth,actorToken}.ts` is platform-agnostic and
carries over with little or no change.

## Credentials you'll need

Same shape as Shopify (see [SETUP.md](../SETUP.md) for how each is obtained):

- A Busymate AI **partner proof secret** (authorizes the proof-of-origin provision path).
- A Busymate AI **provisioning credential** (a rotating OAuth refresh token for a
  least-privilege provisioner identity) — mint with `scripts/mint-provision-credential.mjs`.
- An **ES256 launch key** for identified launch.
- The **actor-token master** (`BMAI_SUPPORT_ACTOR_MASTER`) so your connector can verify
  delegated calls.

## Where to ask

Open a **[discussion or issue](../CONTRIBUTING.md)** describing the platform you're
integrating — porting notes and new-platform contributions are exactly what this
reference exists to seed.
