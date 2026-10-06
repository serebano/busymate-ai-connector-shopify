# Data handling, encryption at rest & retention

This app is the integration layer between a Shopify store and its Busymate AI
white-label tenant. It holds the **minimum** data needed to run that integration.
This document backs the Protected Customer Data (PCD) questionnaire and the App
Store privacy disclosures — every control it attests is implemented in code.

## What the app's own database stores

| Table | Field | Classification | Encrypted at rest | Purpose |
|---|---|---|---|---|
| `Session` | `accessToken` | Shopify offline access token (credential) | **Yes** (AES‑256‑GCM) | Call the store's Admin GraphQL API for the connector tools + KB ingest |
| `Session` | `email` | Staff PII | **Yes** (AES‑256‑GCM) | Shopify session-storage field |
| `Session` | shop, scope, ids | Config | No (non-sensitive) | Session bookkeeping |
| `ShopTenant` | shop, slug, `bmaiTenantId`, `connectorId` | Config identifiers | No | Map the shop ↔ its bmai tenant |
| `BillingState` | status, plan, ids, cursor | Billing config | No | Merchant billing state (no card data — Shopify Billing holds that) |
| `BmaiCredential` | `refreshToken` | OAuth refresh token (credential) | **Yes** (AES‑256‑GCM) | Provisioning credential to the bmai control plane |
| `LaunchKey` | public JWK only | Public key | n/a | Served at `/.well-known/jwks.json` |

The app does **not** store shopper order history, addresses, payment data, or chat
transcripts. Order reads are **live** through the connector (scoped to the signed-in
customer) and are never persisted here. Conversation data lives in the bmai tenant
and is reached only via MCP.

## Encryption at rest

Credential + PII columns are encrypted with **AES‑256‑GCM** (`app/lib/fieldCipher.ts`):

- Key: `APP_ENCRYPTION_KEY` — a 32‑byte key (base64 or hex), held only in the app
  host's secret env (`/etc/busymate-ai-shopify/env`, mode 0600). Value‑blind: never
  logged. Production sensitive writes fail closed if the key is missing or malformed;
  the credential-free no-key passthrough is limited to development/test operation.
- Envelope: `enc:v1:<base64(iv | tag | ciphertext)>`. GCM authentication means a
  tampered value fails to decrypt rather than returning a wrong plaintext.
- Applied by the `EncryptedSessionStorage` decorator (session `accessToken` +
  `email`) and the bmai credential store (`refreshToken`); `adminForShop` decrypts
  on read. Legacy plaintext rows pass through and upgrade in place on the next write.
- Postgres disk/volume encryption (provider-level) is a second, independent layer.

## Retention windows

| Data | Retained | Deletion trigger |
|---|---|---|
| Session / offline token | While the app is installed | `app/uninstalled` → sessions purged immediately (`onAppUninstalled`) |
| `ShopTenant` / `BillingState` | While installed, then ≤ 48h | `shop/redact` (GDPR, ~48h after uninstall) → full purge (`onShopRedact`) |
| bmai tenant (conversations, KB) | While installed | `app/uninstalled` → `suspend_tenant`; `shop/redact` → `delete_tenant` (via MCP) |
| A shopper's data in the tenant | Until erased | `customers/redact` → `redact_tenant_customer`; `customers/data_request` → `export_tenant_customer_data` |
| bmai provisioning `refreshToken` | Until re-auth/rotation | Rotates on every use; superseded value overwritten |

The three mandatory GDPR webhooks (`app/routes/webhooks.compliance.tsx` →
`app/lib/compliance.ts`) actually perform export/erase/teardown and return a non‑2xx
on failure so Shopify retries — they never silently 200.

## Sub-processors

- **Shopify** — the platform (store data, Billing, webhooks).
- **Busymate AI** (`busymate.ai`, including `busymate.ai/mcp`) — the AI tenant + control
  plane, reached only via MCP (`all-ops-via-MCP`).
- The app's own **Postgres** host — an independent failure domain; stores only the
  columns above.

## Where the customer-facing policy is published

The public privacy policy + FAQ (drafts in [`legal/privacy.md`](./legal/privacy.md)
and [`legal/faq.md`](./legal/faq.md)) are published at
`https://store.busymate.ai/legal/privacy` and `https://store.busymate.ai/legal/faq`
(the URLs referenced in `listing/en.json` and on the canonical store record).
