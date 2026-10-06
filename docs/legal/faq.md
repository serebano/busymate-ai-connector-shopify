<!--
  Merchant/shopper FAQ for "Busymate AI for Shopify". Published at
  https://store.busymate.ai/legal/faq (the faq_url in listing/*.json; render with
  `node scripts/render-legal.mjs`). Last updated: 2026-09.
-->

# Busymate AI for Shopify — FAQ

## What does the app do?
It adds **your mate**, an AI support assistant, to your storefront. Your mate answers only from
your own products, pages and policies — grounded and source-cited, and it says so when it
isn't sure — handles order-status questions, and can process returns, refunds and
cancellations with your confirmation. It replies in your shoppers' languages and hands
off to your team when confidence is low.

## How does it install and set up?
One click from the Shopify App Store. On install we provision your store's assistant and
train it on your catalogue, pages and policies. Then switch the storefront assistant on:
open the App's Home page and click **Turn on the storefront assistant** — it opens your
theme editor with the **Busymate AI assistant** app embed pre-activated; click **Save**.
(Manually: Online Store → Themes → Customize → App embeds → switch on
**Busymate AI assistant** → Save.) No theme code editing.

## Where does the assistant get its answers?
Only from **your** store: your products, pages and policies. Answers are cited, and
the assistant refuses or offers a human handoff when it isn't confident. It does not
make up store facts.

## Can it really take order actions?
Yes — for signed-in shoppers, scoped to **their own** orders. It can look up status
and tracking, and (with confirmation) update a shipping address, start a return, cancel
an unfulfilled order, or issue a refund. Refunds are capped; above the cap it escalates
to a human instead of auto-refunding. Higher-risk actions always require confirmation.

## Which permissions do you request, and why?
Least-privilege Shopify scopes: read products, content, orders, customers and
fulfilments (to answer and look up orders), and write orders + returns (to perform the
confirmed actions above). We do not request theme access — you switch the app embed on
yourself in the theme editor. Access to orders older than 60 days is requested separately
at review time.

## How does billing work?
Through **Shopify App Pricing** on your Shopify invoice — never an external checkout.
Four plans: **Free** ($0 — 25 AI resolutions a month, then conversations route to your
team), **Starter** ($19/month — 38 resolutions included, then $0.49 each, $200/month
overage cap), **Growth** ($99/month — 225 included, then $0.44 each, $1,000/month cap) and
**Scale** ($349/month — 830 included, then $0.42 each, $5,000/month cap). Paid plans have
a 14-day free trial. A "resolution" is a conversation the assistant resolved without a
human. The cap limits charges, not the assistant: the storefront widget **keeps working
past the cap** and on the Free plan — it is never switched off for billing. Choose or
change your plan from the App's Billing page (it opens Shopify's plan-selection page).

## Can I see what shoppers asked?
Yes. The App's **Conversations** page lists recent conversations and open human-handoff
requests for your store, and the Busymate AI inbox shows the full transcripts.

## Is my data safe? What do you store?
We store the minimum needed to run the integration (store/tenant identifiers, your
Shopify access token, billing status). The access token and staff email are
**encrypted at rest**. We do **not** store shopper order history, addresses or payment
data — order data is read live and scoped to the signed-in shopper. See the
[Privacy Policy](https://store.busymate.ai/legal/privacy) and the merchant
[Terms & Data Processing Addendum](https://store.busymate.ai/legal/terms).

## What happens to data if I uninstall?
On uninstall we suspend your assistant and purge sessions immediately. Shopify's
`shop/redact` (about 48 hours later) triggers a full teardown and purge. Shoppers can
request data export or erasure at any time; we execute those through Shopify's
mandatory privacy webhooks.

## Which languages are supported?
14: English, Spanish, Portuguese (BR), French, German, Italian, Russian, Romanian,
Turkish, Arabic (RTL), Simplified Chinese, Hindi, Japanese and Korean — auto-detected.
The storefront launcher label is translated for each of them.

## How do I get help?
Email **hi@busymate.ai** (we respond within two business days).
