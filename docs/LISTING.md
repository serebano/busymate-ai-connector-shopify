# App Store listing — content skeleton (localized ×14)

The Shopify App Store listing must be **localized into 14 locales** (Built-for-Shopify).
The copy lives under `listing/` — one JSON per locale, same keys — and is **derived from
the canonical store record** (`GET https://busymate.ai/api/store/apps/busymate-ai-shopify`,
see [`STORE-SINGLE-SOURCE.md`](./STORE-SINGLE-SOURCE.md)). Screenshots and the demo
screencast are owner-provided assets (capture on the best fleet iPhone/desktop).

## Locales (14 Tier-1)

`en · es · pt-BR · fr · de · it · ru · ro · tr · ar · zh-Hans · hi · ja · ko`
(RTL for `ar`). Shopify storefront/extension locale codes use `zh-CN` for `zh-Hans`.
The same 14 locales exist on the canonical record (`set_store_app_locale` on
`busymate.ai/mcp`) so `busymate.ai/store` and the Shopify listing say the same thing.

## Listing fields (per locale) → Partner Dashboard field

| Key | Partner field | Limit | Notes |
|---|---|---|---|
| `app_name` | App name | 30 | "Busymate AI" (brand constant) |
| `tagline` | Subtitle (Discovery) | 62 | = the record's tagline (drift-checked) |
| `intro` | Introduction | 100 | = paragraph 1 of the record's description (drift-checked) |
| `details` | App details | 500 | = paragraph 2 of the record's description (drift-checked) |
| `feature_bullets` | Features | 3–5 × 80 | = the record's "What it does" bullets |
| `pricing_summary` | — (busymate.ai store page only) | — | the ONLY field that may talk about plans |
| `privacy_url` | Privacy policy URL | — | `https://store.busymate.ai/legal/privacy` (= record `privacyUrl`, drift-checked) |
| `faq_url` | FAQ URL | — | `https://store.busymate.ai/legal/faq` |

Pricing plans are NOT in these files — `listing/pricing.json` is regenerated from the record
by `npm run listing:sync` and is the source-of-record for the Partner "Pricing details" /
App Pricing plans.

## Copy rules (App Store requirements, enforced by `test/listing-copy.test.ts`)

- **4.2.3 — pricing only in Pricing details.** `intro`, `details` and `feature_bullets`
  carry no pricing words (pay, price, cap, trial, free, $ …). The editor's REVIEW TIP
  flags even the word "pay". Plans live in `pricing_summary` / `listing/pricing.json`.
- **4.3.3 / 4.4.1 — no statistics or data.** No numerals anywhere in the partner-form
  fields, in any script — a language count ("14 languages") is data; say "in the
  shopper's language" instead.
- **4.3.x — factual copy.** No guarantees, no superlatives, no competitor-flaw
  positioning. Grounding is described as "answers only from your own products, policies
  and store content, with sources, and says when it is not sure" — never "no
  hallucinations". Claim only what the shipped product does.
- Every locale is a **real translation** (not an English placeholder) and links the same
  legal pages; `ar` copy is RTL-safe (Arabic sentences, Latin only for the brand name).

## Positioning (the three wedges)

- **TRUST** — answers only from the store's own content, with sources; says when unsure.
- **MULTILANG** — replies in the shopper's language, RTL included (uncontested in the category).
- **ACCESS** — enterprise-grade autonomous resolution at an honest SMB price, self-serve,
  no demo wall (the price itself is stated only in Pricing details).

## Change flow

1. Edit the canonical record over MCP on `busymate.ai/mcp` — `upsert_store_app`
   (`description_md` paragraph 1 = intro, paragraph 2 = details, then the bullets and the
   Pricing section; `privacy_url`), `set_store_app_pricing`, `set_store_app_locale` ×14.
   Never a backdoor DB write.
2. Update `listing/en.json` + the 13 locale files in the same change; `npm run listing:sync`
   regenerates `listing/pricing.json`.
3. `npm run drift-check` (must be green) + `npm test` (`listing-copy`, `listing-drift`,
   `naming`, `storeListing` cover the copy).
4. Hand-apply the copy in the Partner Dashboard listing editor (Shopify has no API for it).

## Listing in the Busymate AI directory (optional)

Once the Shopify App Store listing exists and is approved, the app can also be registered
in the Busymate AI directory via MCP (no backdoor writes) so it is discoverable alongside
other Busymate AI integrations. Do this only after the App Store listing URL exists — the
directory `install_url` points at the live App Store page.

## Assets checklist (owner-provided)

- [x] App icon (1200×1200, `listing/assets/icon-1200.png`)
- [ ] Feature image (1600×900) — real widget UI, no pricing text, no Shopify wordmark, no counts
- [ ] 3–6 desktop screenshots (1600×900) + 3 mobile — each a different view, browser chrome cropped
- [ ] Setup screencast (3–8 min, English; install → onboarding → embed → storefront flow), mp4/H.264
- [ ] Demo store (`busymate-ai-demo-store.myshopify.com`) + test customer/order in the testing instructions
- [ ] Billing step in the testing instructions (review risk D). Shopify's
  "Manage apps → Billing" shows **"No plan selected"** until a plan is chosen — under Shopify App
  Pricing even the $0 Free plan is a subscription contract that only exists once selected (Partner
  API `activeSubscription` is `null` and there are no `SUBSCRIPTION_*` events on a fresh install;
  verified on the review dev store 2026-09-02). The app says the same ("No plan selected yet") and
  never claims "You're on the Free plan" without a contract. Paste into the testing instructions:

  > Billing uses Shopify App Pricing (no off-platform charges). In the app open **Billing → Choose a
  > plan** — Shopify's hosted plan page opens; pick the **$0 Free plan** (or any paid plan: dev
  > stores test at no charge) and approve. The subscription then appears under **Settings → Apps
  > and sales channels → Busymate AI → Billing** and the app's Billing page shows the plan. Until
  > you choose, both Shopify and the app show "No plan selected" and the assistant runs at Free-plan
  > limits.
