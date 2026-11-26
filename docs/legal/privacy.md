<!--
  Privacy policy for the "Busymate AI for Shopify" app. This is app-specific
  (NOT the devtools privacy policy). Published at https://store.busymate.ai/legal/privacy
  (the URL in listing/*.json and on the canonical store record; render with
  `node scripts/render-legal.mjs`). Checked against the code on 2026-11-26 (scopes in
  shopify.app.toml, prisma/schema.prisma, app/mcp/tools/*, app/lib/themeEmbed.ts,
  app/lib/encryptedSessionStorage.ts). Legal review by the owner/counsel is still an
  owner decision; see the flags in .coordination/audits/shopify-audit-20261125.md (L5).
-->

# Busymate AI for Shopify — Privacy Policy

**Effective date:** August 29, 2026 (updated November 26, 2026)

This policy explains what data the **Busymate AI for Shopify** app ("the App", "we")
collects, why, how long we keep it, and the rights you have. It covers two groups of
people: **merchants** who install the App, and **shoppers** who interact with the
assistant on a merchant's storefront. It is written to satisfy the EU/UK **GDPR** and
the **California CCPA/CPRA**.

The App is the integration layer between a Shopify store and its **Busymate AI**
white-label assistant (shown to shoppers under the store's name). It reaches the Busymate AI platform only through
official APIs and holds the minimum data needed to run the integration.

## 1. Who is responsible (controller / processor)

- For **merchant account data** and the App's own operational data, Busymate AI is the
  **controller**.
- For **shopper personal data processed on a merchant's behalf** (e.g. order lookups,
  conversation content), the **merchant is the controller** and Busymate AI is a
  **processor** acting on the merchant's instructions.

Contact: **hi@busymate.ai**.

## 2. What we collect and why

### Merchant data
| Data | Purpose | Legal basis (GDPR) |
|---|---|---|
| Shopify store domain, shop + tenant identifiers | Run the integration; map the store to its assistant | Contract |
| Shopify **offline access token** and its refresh token (both encrypted at rest) | Call the store's Admin API for the assistant's tools and knowledge-base training | Contract |
| Staff email, when Shopify includes it in the admin session (encrypted at rest). We do not store staff names | Account operation, support | Contract / legitimate interest |
| Theme setting **read only**: the main theme's `config/settings_data.json`, read on the App's Home page to tell whether our app embed is switched on (`read_themes`). Only the on/off state is used and shown; the file is not stored and nothing is written to your theme | Show the setup step as done or not done | Contract |
| Store content you already publish: products, pages and policies (`read_products`, `read_content`, `read_legal_policies`) | Train the assistant so it answers only from your store | Contract |
| Billing status + plan (no card data) | Plan and usage billing via Shopify App Pricing | Contract |

### Shopper data (processed on the merchant's behalf)
| Data | Purpose | Legal basis |
|---|---|---|
| Signed-in customer identifier (from Shopify) | Scope order lookups to the shopper's **own** orders | Controller (merchant): contract/legitimate interest |
| Order details read live for a signed-in shopper: order number, dates, payment and fulfilment status, total, line items, tracking numbers and links (`read_orders`, `read_customers`, `read_fulfillments`) | Answer "where is my order" | As above |
| Name, address and phone number the shopper **types** to change an order's shipping address; the order and refund change on a cancellation (`write_orders`) | Change the shipping address of an unshipped order or cancel an unfulfilled order, only after the shopper confirms in the chat | As above |
| Conversation content (everything the shopper types, which can include name, email, phone or address) | Provide the assistant and the merchant's Conversations inbox | As above |

We do **not** sell personal information, and we do **not** use shopper data for
cross-context behavioural advertising. We do **not** store shopper order history,
addresses, phone numbers, or payment details in the App's own database — order data is read
**live** from Shopify, scoped to the signed-in shopper, and the App never reads card data.
What a shopper types in the chat is kept in the conversation record held by Busymate AI (see
section 3 and the retention table), not in the App's database.

## 3. Where data is processed (sub-processors)

- **Shopify** — the commerce platform (store data, Billing, webhooks).
- **Busymate AI** (`busymate.ai`) — the AI assistant + control plane, reached only via
  the Busymate AI MCP APIs.
- The App's own **database host** — an independent, access-controlled Postgres holding
  only the identifiers/tokens listed above.
- The underlying **LLM provider(s)** used by Busymate AI to generate answers, under
  data-processing terms that prohibit training on your data.

A current sub-processor list is available on request.

## 4. Security

- Credential and PII columns (the access and refresh tokens, the provisioning refresh
  token, staff email) are **encrypted at rest with AES-256-GCM** at the application
  layer, in addition to provider disk encryption.
- Access to the assistant's order actions is gated: a shopper is verified by a signed,
  short-lived identity token and can only see and act on their **own** orders, and every order change
  requires their explicit confirmation.
- Secrets are held only in the host's protected environment and are never logged.

## 5. Retention

| Data | Kept for | Deleted when |
|---|---|---|
| Session / access token | While the App is installed | On uninstall (immediate purge) |
| Store↔tenant + billing records | While installed, then ≤ 48 hours | On Shopify `shop/redact` (full purge) |
| Assistant tenant data: knowledge base | While installed | Uninstall → suspended; `shop/redact` → deleted |
| Shopper conversations (messages, handoff notes) | 90 days after the last activity by default; the merchant can set 1 to 3,650 days in the Busymate AI Console | By the platform retention sweep after that window; also on a `customers/redact` request, on `shop/redact`, or when the merchant deletes the conversation |
| A shopper's data in the tenant | Until erased | On a `customers/redact` request |

Full detail: see the App's data-retention notes.

## 6. Your rights

**GDPR (EU/UK):** access, rectification, erasure, restriction, portability, objection,
and the right to lodge a complaint with a supervisory authority. Shoppers should
contact the **merchant** (the controller); the App executes the merchant's
export/erase instructions through Shopify's mandatory data-request, customer-redact,
and shop-redact webhooks.

**CCPA/CPRA (California):** the right to know, delete, correct, and to limit use of
sensitive personal information, and the right not to be discriminated against for
exercising them. We do **not** sell or "share" personal information as those terms are
defined by the CPRA.

To exercise a right, contact the merchant you interacted with, or **hi@busymate.ai**.

## 7. International transfers

Data may be processed outside your country. Where required, transfers rely on
appropriate safeguards (e.g. the EU Standard Contractual Clauses).

## 8. Children

The App is not directed to children and does not knowingly collect data from them.

## 9. Changes

We will update this policy as the App evolves and post the new effective date here.

## 10. Contact and merchant terms

**Busymate AI** — hi@busymate.ai (we answer privacy requests within 30 days).

Merchants: the [Terms of Service & Data Processing Addendum](https://store.busymate.ai/legal/terms)
sets out our processor obligations to you (roles, security, sub-processors, breach
notification, deletion, audit).
