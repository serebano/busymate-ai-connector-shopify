<!--
  Merchant Terms of Service + Data Processing Addendum for "Busymate AI for
  Shopify". Published at https://store.busymate.ai/legal/terms (render with
  `node scripts/render-legal.mjs`). Linked from the privacy policy §10, the App
  Store listing's additional documentation, and the Protected Customer Data
  questionnaire ("privacy and data protection agreements with merchants").
  Last drafted: 2026-09. Have counsel review before relying on it.
-->

# Busymate AI for Shopify — Terms of Service & Data Processing Addendum

**Effective date:** September 2, 2026

These terms ("Terms") govern the **Busymate AI for Shopify** app ("the App") that
**Busymate AI** ("we", "us") provides to the Shopify merchant who installs it ("you",
"the Merchant"). By installing or using the App you agree to these Terms. Part B is the
**Data Processing Addendum** ("DPA") that applies whenever we process personal data of
your shoppers on your behalf.

Contact for anything in these Terms: **hi@busymate.ai**.

## Part A — Terms of Service

### 1. The service

The App adds **your mate**, an AI support assistant, to your Shopify storefront. Your mate answers
shopper questions from your own products, pages and policies, looks up a signed-in
shopper's own orders, and — only with the shopper's confirmation and inside the limits
you set — can update a shipping address, start a return, cancel an unfulfilled order or
issue a refund. The App is an integration between Shopify and the Busymate AI platform;
it does not replace your own customer service.

### 2. Your account and responsibilities

- You must be authorised to install apps on the store and to bind the Merchant to these
  Terms.
- You are responsible for the content of your store (products, policies, pages) that the
  assistant is trained on, for reviewing the assistant's settings, and for the actions
  you allow it to take.
- You will use the App in compliance with Shopify's terms, applicable law, and your own
  privacy policy toward shoppers.

### 3. Plans, billing and trials

- All charges are billed **through Shopify App Pricing** on your Shopify invoice. We never
  bill you outside Shopify.
- Plans are shown on the App Store listing and on Shopify's plan-selection page. Paid
  plans have a monthly fee that includes a number of AI resolutions; resolutions beyond
  the allowance are charged per resolution, up to that plan's monthly overage cap, after
  which no further overage is charged that month. The **Free** plan includes a monthly
  allowance, after which conversations are routed to your team.
- Paid plans start with a **14-day free trial**; you can change or cancel your plan any
  time from the App's Billing page or Shopify's Manage apps page. Fees already billed are
  not refunded except where required by law.
- The storefront assistant is **never switched off for billing reasons** — not on the
  Free plan and not when a cap is reached.

### 4. AI output

The assistant generates answers with large language models. It is designed to answer
only from your store's content, to cite its sources, and to hand off to a human when it is
not confident, but AI output can still be inaccurate or incomplete. You should review the
assistant's behaviour on your store, keep your policies current, and treat its answers as
assistance to your customer service, not as legal, financial or medical advice.

### 5. Acceptable use

You will not use the App to break the law, infringe others' rights, send spam, collect
data you are not entitled to collect, attempt to access other merchants' data, or reverse
engineer or overload the service.

### 6. Intellectual property

We own the App and the Busymate AI platform. You own your store content and your shoppers'
data. You grant us the licence needed to process that content and data to provide the
service to you, and nothing more. We do not use your data to train models for other
customers.

### 7. Availability and support

We aim to keep the service available at all times but do not guarantee uninterrupted
operation. Support is available at **hi@busymate.ai**; we respond to merchant
requests within two business days.

### 8. Termination

You can uninstall the App at any time. On uninstall we suspend your assistant and delete
your Shopify session immediately; Shopify's `shop/redact` request (about 48 hours later)
triggers a full deletion of your store's data (see the Privacy Policy). We may suspend or
terminate the service for a material breach of these Terms or where required by law.

### 9. Warranties and liability

The App is provided "as is". To the extent permitted by law we exclude implied warranties,
and our total liability arising from the App in any 12-month period is limited to the fees
you paid us for the App in that period. Nothing limits liability that cannot be limited by
law.

### 10. Changes; governing law

We may update these Terms; material changes are announced in the App and take effect 30
days after posting. These Terms are governed by the laws of Romania and the courts of
Bucharest have jurisdiction, without prejudice to mandatory consumer or data-protection
law that applies to you.

## Part B — Data Processing Addendum

### 1. Roles

For shopper personal data that the App processes to provide the service (order lookups,
conversation content, handoff requests), **you are the controller and we are your
processor**. For your own merchant account data we are an independent controller (see the
[Privacy Policy](https://store.busymate.ai/legal/privacy)).

### 2. Subject matter, duration, nature and purpose

| Item | Detail |
|---|---|
| Subject matter | Operating an AI support assistant on your storefront |
| Duration | While the App is installed, plus the deletion window in §7 |
| Nature | Storing conversations, reading order data live from Shopify, executing confirmed order actions |
| Purpose | Answering shopper questions and performing the actions you enable |
| Data subjects | Your shoppers and your staff who use the App |
| Data categories | Shopify customer identifier, order and fulfilment details, conversation content, handoff requests, staff name and email |

### 3. Processing on your instructions

We process shopper data only on your documented instructions — these Terms, the App's
settings, and Shopify's mandatory privacy webhooks — unless law requires otherwise, in
which case we inform you unless prohibited. We do not sell shopper data or use it for
advertising, and we do not use it to train models for anyone else.

### 4. Confidentiality and security

Our personnel with access to shopper data are bound by confidentiality. We apply technical
and organisational measures appropriate to the risk, including: encryption in transit
(TLS 1.2+) and at rest (application-layer AES-256-GCM for tokens and staff email, plus
provider disk encryption); least-privilege Shopify scopes; a signed, short-lived identity
token that lets a shopper act only on their **own** orders; confirmation gates and a cap on
refunds; secrets held only in the host's protected environment; and access logging.

### 5. Sub-processors

You authorise the sub-processors listed in the Privacy Policy (Shopify; the Busymate AI
platform; the App's database host; the LLM providers Busymate AI uses under terms that
prohibit training on your data). We remain responsible for them, flow down equivalent
obligations, and give you notice of additions so you can object.

### 6. Data subject requests and assistance

We help you meet shopper requests: Shopify's `customers/data_request` webhook triggers an
export of the shopper's data held in your assistant tenant, and `customers/redact`
triggers erasure. We assist with security, breach notification and data-protection impact
assessments to the extent the information is within our control.

### 7. Deletion and return

On uninstall we suspend the assistant and delete your Shopify session immediately. On
Shopify's `shop/redact` webhook (about 48 hours after uninstall) we delete the store's
tenant data (conversations, knowledge base, identifiers, billing state), except where
retention is required by law.

### 8. Breach notification

We notify you without undue delay, and in any case within 72 hours, after becoming aware
of a personal-data breach affecting your shopper data, with the information you need to
meet your own obligations.

### 9. International transfers

Where shopper data leaves the EU/UK, we rely on appropriate safeguards (the EU Standard
Contractual Clauses and the UK Addendum) with our sub-processors.

### 10. Audit

On reasonable request, no more than once a year unless required by a supervisory
authority, we provide the information needed to demonstrate compliance with this DPA and
allow audits you conduct or mandate, at your cost, under confidentiality.

### 11. Governing law

This DPA is governed by the same law as Part A, without prejudice to the GDPR, the UK GDPR
and the CCPA/CPRA where they apply.
