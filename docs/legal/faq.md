<!--
  Merchant/shopper FAQ for "Busymate AI for Shopify". Published at
  https://store.busymate.ai/legal/faq (the faq_url in listing/*.json; render with
  `node scripts/render-legal.mjs`; since 2026-10-23 the app itself serves it at
  /legal/shopify-faq). Last updated: 2026-10-23. Every sentence here is checked against the
  live app (busymate-ai-src#2624) — only claim what a reviewer can test.
-->

# Busymate AI for Shopify — FAQ

## What does the app do?
It adds your store's own AI support assistant to your storefront. Shoppers meet it as
"*your store name* AI" unless you give it another name in **Assistant settings**. It answers
only from your own products, pages and policies, says so when it isn't sure, answers a
signed-in shopper's questions about their own orders (status and tracking; with their confirmation, cancelling an unfulfilled order or changing its shipping address), replies in your
shoppers' languages, and hands the conversation to your team when a shopper asks for a person.

## How does it install and set up?
One click from the Shopify App Store. On install we provision your store's assistant and
train it on your catalogue, pages and policies. Then switch the storefront assistant on:
on the App's Home page, open **App embeds** (the button opens your theme editor), switch on
**Busymate AI assistant** and click **Save**. (Manually: Online Store → Themes → Customize →
App embeds → switch on **Busymate AI assistant** → Save.) No theme code editing. If your store
is password-protected, Home cannot check the storefront from outside; choose
**It's switched on** after saving and the step shows as done.

## Where does the assistant get its answers?
Only from **your** store: your products, pages and policies (re-trained automatically when
products change, and on demand from **Store connection → Re-train on my store**). When it
isn't sure it says so and offers to connect the shopper with your team. It does not make up
store facts.

## Can it really take order actions?
For signed-in shoppers, and only for **their own** orders. It can look up order status
and tracking. With the shopper's explicit confirmation (an **Approve** button in the chat) it
can cancel an unfulfilled order (Shopify refunds it) and change the shipping address of an
order that has not shipped yet. Anything else — a return, a partial refund, a delivery
problem — goes to your team: the shopper asks for a person and you reply from
**Conversations** in your Shopify admin.

## Which permissions do you request, and why?
Least-privilege Shopify scopes: read products, content, orders, customers and
fulfilments (to answer and look up orders), and write orders + returns (for the confirmed
order changes above). We do not request theme access — you switch the app embed on
yourself in the theme editor. Orders older than 60 days are not read.

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
Yes, inside your Shopify admin. The App's **Conversations** page lists recent conversations
and open requests for a person; open one to read the full transcript. On a request you can
**Claim and pause assistant**, **Send reply** (it appears in the shopper's chat) and
**Resolve and resume assistant**.

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
