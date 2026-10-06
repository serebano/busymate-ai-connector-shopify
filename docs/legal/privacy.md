<!--
  DRAFT privacy policy for the "Busymate AI for Shopify" app. This is app-specific
  (NOT the devtools privacy policy). Published at https://store.busymate.ai/legal/privacy
  (the URL in listing/*.json and on the canonical store record; render with
  `node scripts/render-legal.mjs`). Have counsel review. Last updated: 2026-09.
-->

# Busymate AI for Shopify — Privacy Policy

**Effective date:** August 29, 2026 (updated September 2, 2026)

This policy explains what data the **Busymate AI for Shopify** app ("the App", "we")
collects, why, how long we keep it, and the rights you have. It covers two groups of
people: **merchants** who install the App, and **shoppers** who interact with the
assistant on a merchant's storefront. It is written to satisfy the EU/UK **GDPR** and
the **California CCPA/CPRA**.

The App is the integration layer between a Shopify store and its **Busymate AI**
white-label assistant ("your mate"). It reaches the Busymate AI platform only through
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
| Shopify **offline access token** (encrypted at rest) | Call the store's Admin API for the assistant's tools and knowledge-base training | Contract |
| Staff name/email from the Shopify session | Account operation, support | Contract / legitimate interest |
| Billing status + plan (no card data) | Plan and usage billing via Shopify App Pricing | Contract |

### Shopper data (processed on the merchant's behalf)
| Data | Purpose | Legal basis |
|---|---|---|
| Signed-in customer identifier (from Shopify) | Scope order lookups to the shopper's **own** orders | Controller (merchant): contract/legitimate interest |
| Order/fulfilment details requested in a chat | Answer "where is my order", process a return/refund/cancellation **you confirm** | As above |
| Conversation content | Provide the assistant; improve grounding for that store | As above |

We do **not** sell personal information, and we do **not** use shopper data for
cross-context behavioural advertising. We do **not** store shopper order history,
addresses, or payment details in the App's database — order data is read **live** and
scoped to the signed-in shopper.

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

- Credential and PII columns (the offline access token, the provisioning refresh
  token, staff email) are **encrypted at rest with AES-256-GCM** at the application
  layer, in addition to provider disk encryption.
- Access to the assistant's order actions is gated: a shopper is verified by a signed,
  short-lived identity token and can only see and act on their **own** orders; refunds
  are capped and higher-risk actions require confirmation.
- Secrets are held only in the host's protected environment and are never logged.

## 5. Retention

| Data | Kept for | Deleted when |
|---|---|---|
| Session / access token | While the App is installed | On uninstall (immediate purge) |
| Store↔tenant + billing records | While installed, then ≤ 48 hours | On Shopify `shop/redact` (full purge) |
| Assistant tenant data (conversations, KB) | While installed | Uninstall → suspended; `shop/redact` → deleted |
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
