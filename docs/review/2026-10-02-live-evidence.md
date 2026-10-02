# Live evidence — 2026-10-02 "100 % ready" run

Store **`busymate-ai-review-test-7`** (brand-new, created today in Dev Dashboard org 233014681 with
test data, Basic plan). App **0.1.14** (`a58ae33`) for the install → plan cycle, **0.1.15** (`555918f`)
deployed 12:48 UTC and used for the cancel/reinstall, theme and Web-Vitals checks. App version
**`busymate-ai-6`** (released 2026-10-02 11:42 UTC: hardened `assistant.js` + `domains/*` webhooks).
Platform ai 1078. Browser: the `shopify-dev` bmc Chrome through the DevTools MCP, real mouse input.
Evidence files: `/Users/serebano/bm-lanes/boss-state/proof/shopify-audit/` (`rerun-test-7/`, `themes/`,
`listing-screenshots/`, `reviewer-screencasts/`). Tracking: busymate-devtools#3995.

## Reviewer path (continuous screencast)

`rerun-test-7/screencast-reviewer-flow-test-7.mp4` — 34.5 min, 1280×720 H.264, two takes joined
(the first recorder hit its 25-min cap after the Growth approval; the plan cycle was re-recorded in full).
Public copy, linked in the Partner submission form:
`https://api.busymate.ai/storage/v1/object/public/store-assets/shopify/busymate-ai-reviewer-flow-2026-10-02.mp4`.

| UTC | Step | Result | Shot |
|---|---|---|---|
| 11:49:5x | Install from the Dev Dashboard install link → grant → Install | Home painted **2/4 · Live** on first paint (afterAuth 11:50:0x, trained 15/17 products, 1 policy, 2 pages) | R01 |
| 11:51 | "Turn on the storefront assistant" | Theme Editor opens on the `test-data` theme with the embed **on**, Save enabled, "Ask us" launcher in the preview | R02 |
| 11:53 | Save → "Ask us" | real chat (no refused frame) | R03 |
| 11:55 | "What products do you sell and what is your refund policy?" | answered from the catalogue; the policy part is honest (the test store has no refund policy) | R04 |
| 11:57 | anonymous storefront (new browser context, storefront password) | launcher from `busymate-ai-6/assets/assistant.js`, chat opens | R05 |
| 12:02:00 | Uninstall (Settings → Apps, reason "Testing multiple apps") | `app/uninstalled` **200** at 12:02:03, tenant suspended (`embed-status frameable:false`) | — |
| 12:03:15 | Reinstall (73 s later) | afterAuth → "reinstalled (tenant reactivated)" 12:03:20, `frameable:true` at **revision 4** (no deadlock) | R06, R08 |
| 12:05 | anonymous storefront after reinstall | launcher + chat open | R07 |
| 12:07 | close everything, reopen Theme Editor | embed **on and saved**, launcher present | R09 |
| 12:09–12:17 | plans Free → Growth → Scale → Free on Shopify's hosted page | every approval redirects back to Billing with `plan_handle`; Home stays Live | R10–R14 |
| 12:19–12:26 | plan cycle repeated for the recording | same | screencast part 2 |

Found on the reinstall paint (R06): Home read "1/4 · Activating / Assistant provisioned: To do" with the
CTA already enabled and no self re-check (frameable before readiness). Fixed the same day in **0.1.15**
(`homeActivation` returns `recheck` separately from `activating`; PR #48).

## Web Vitals — embedded Home, reviewer path (0.1.15, foreground load, 2026-10-02 12:30 UTC)

Measured inside the app frame (`PerformanceObserver`, buffered) on a fresh load of
`admin.shopify.com/store/busymate-ai-review-test-7/apps/busymate-ai/app`:

| Metric | Value | Target | |
|---|---|---|---|
| LCP | **1 972 ms** (Polaris text in the setup card) | ≤ 2 500 ms | pass |
| CLS | **0.040** | ≤ 0.1 | pass |
| INP | **< 16 ms** on the real click of "Refresh status" (no `event` entry crossed the 16 ms reporting floor; the click was served: `POST /app/billing.data` 763 ms) | ≤ 200 ms | pass |
| TTFB | 1 870 ms | — | the loader's readiness + frameability + storefront reads; the data revalidation after Refresh took 3.4 s server-side (Partner API active-subscription read). Worth trimming, not a review requirement |
| Transfer | 19 resources, 146 kB JS | | |

## Themes (app embed via the app's deep link, desktop + mobile preview)

| Theme | Kind | Deep link activates | Launcher (desktop) | Chat | Mobile preview | Shot |
|---|---|---|---|---|---|---|
| `test-data` (Horizon family, active) | OS 2.0 | yes | yes | answers | — (storefront on phone: R05/R07 layout) | R02–R04 |
| Horizon 154521993377 | OS 2.0 | yes (`activateAppId=`) | yes | answers | full-height sheet, composer visible | T02–T04 |
| Dawn 154523435169 | OS 2.0 | yes | yes | — | launcher inside the phone frame | T05–T06 |
| debut-vintage-theme 154522026145 | vintage | yes | yes | — | launcher inside the phone frame | T07–T08 |

Note for the docs: Shopify rewrites `activateAppId=` to `appEmbed=` after loading. Opening a draft theme's
editor with the **rewritten** `appEmbed=` URL does **not** activate the embed (T01) — the app must always
link with `activateAppId=` (it does: `app/lib/themeEmbed.ts`).

## Billing

- Plan changes Free → Growth → Scale → Free (twice), each through Shopify's hosted App Pricing page,
  each redirect handled by `/app/billing?plan_handle=…` (R10–R14). Downgrade Scale → Free works.
- Partner App history shows the matching "Subscription charge activated / canceled" pairs.
- **Cancel + reinstall-after-cancel:** on Growth (test, 14-day trial) → uninstall (13:05:09, webhook 200)
  → reinstall (13:07:07). Shopify's own admin card then reads "Billing · $0/month + usage · Growth · Plan
  expires Oct 16" and the app's Billing page reads "Your plan: Growth — Trial, ends 10/16/2026" (R15, R16):
  App Pricing keeps the test subscription across uninstall → reinstall on a development store and the app
  mirrors Shopify exactly (Partner API `activeSubscription`). "Cancel" under App Pricing is the switch to
  the Free plan (proven) or Shopify's own cancellation; the admin offers no separate cancel control for
  a $0 test subscription. The app's Billing copy already says where to change or cancel.

## Webhooks / tokens (0.1.15 on the live unit, 12:48 UTC)

`npm run webhooks:probe` → **10/10**: `customers/data_request`, `customers/redact`, `shop/redact`,
`app/uninstalled`, `app/scopes_update`, `app_subscriptions/update`, `domains/create|update|destroy`,
`products/update` answer **200 ≤ 18 ms** for a shop whose offline session is expired, **401** on a bad
HMAC. `npm run tokens:audit` → every offline session is an expiring token (permanent 0). Dev Dashboard
(Operations, last 7 days): GraphQL error rate 0 %, webhook failure rate **0 %** (14 deliveries today),
P90 webhook response 568 ms, no API-health action items (the only banner is the review suspension).
Details: `2026-10-02-webhooks-proof.md`.

## Listing / Partner form (saved 2026-10-02, not submitted)

| Field | Now |
|---|---|
| Support email | `hi@busymate.ai` |
| Screencast URL | the 2026-10-02 reviewer-flow mp4 above (200) |
| Testing instructions | `testing-instructions.md` text incl. the demo store's storefront password and the 0.1.14 / `busymate-ai-6` fix line (2 598 chars) |
| "My app doesn't require an account" | checked |
| Pricing details | Starter / Growth / Scale / Free — identical to the App Pricing page and the app's Billing page |
| App name | "Busymate AI" (= Dev Dashboard) |
| Screenshots | 4 desktop (1600×900) + 3 mobile already uploaded, real app UI with alt texts. Four refreshed 1600×900 shots of today's build are ready for the owner to swap in (the form's uploader needs the native file chooser): `https://api.busymate.ai/storage/v1/object/public/store-assets/shopify/listing-2026-10-02/01-home-live-setup-checklist.png`, `…/02-billing-plans-shopify-app-pricing.png`, `…/03-theme-editor-app-embed-chat.png`, `…/04-storefront-shopper-chat.png` |
| Listing languages | English primary; Shopify translates approved listings into the top App Store languages itself (form header). Our own 14-locale copy stays the single source for the store record |
| Protected customer data | Draft updated: Customer service + App functionality; fields **Name, Phone, Address** (Customer service); **Email removed**; 16/16 data-protection answers. Shopify's install screen already lists "Name, Phone number, Physical address" |

TLS (3.1.1): `store.busymate.ai` Let's Encrypt, valid 2026-08-28 → 2026-11-26; `busymate.ai` valid
2026-09-24 → 2026-12-23; `/api/bmai/status` 200 over HTTP/2.

## Owner items — done on the owner's delegation ("U can do all yourself", 2026-10-02, via the boss)

1. **Protected customer data:** the draft is complete (Customer service + App functionality; Name, Phone, Address;
   Email removed; 16/16 data-protection answers). Shopify has no separate submit for it — the page says the
   request is reviewed when the App Store listing is submitted, so it goes in with the resubmission.
2. **Emergency developer contact** (Partner Dashboard → Settings → Emergency developer contact information):
   email `hi@busymate.ai`, phone `+37361122113` — saved 2026-10-02 (the org-level form has no name field).
3. **Listing screenshots swapped:** the four desktop slots now carry the 2026-10-02 1600×900 set in order
   Home (Live checklist) → Theme Editor (embed on, chat answering) → Storefront (shopper chat) → Billing
   (App Pricing plans), each with a ≤ 64-char alt text; the three mobile screenshots stay. Saved and verified
   after a reload. Recipe for next time: a Polaris DropZone that already holds an image is `disabled`
   (drag-drop and `DOM.setFileInputFiles` are ignored) — Delete the slot, Add a new one, then
   `DOM.setFileInputFiles` on the enabled input uploads immediately.
4. **Resubmission** is only possible on/after 2026-10-08. A launchd waiter on the Mac mini
   (`net.busymate.waiter.shopify-resubmit-20261008`, script `bm-lanes/boss-state/waiters/shopify-resubmit-2026-10-08.sh`)
   posts the reminder to the team group at 10:00 Europe/Chisinau that day; the day-of reviewer run on a
   brand-new store comes first, the submit only if it is all green.
