<!-- Paste source for the Partner Dashboard "Testing instructions" field (2800 chars max).
     Before pasting (audit 2026-10-02, docs/review/2026-10-02-audit.md): the form's "Demo store URL"
     is a password-protected development store — either add its storefront password to the ACCESS
     paragraph below (the password lives in that store's Online Store → Preferences, never in this
     public repo) or clear the Demo store URL field. Support email in the form: hi@busymate.ai.
     Screencast URL: a link that opens without sign-in (not the retired api.busymate.net host). -->
ACCESS / REQUIREMENT 4.5.4
No separate Busymate AI account, password, SSO or two-factor login exists or is required: Shopify authenticates the embedded app, and shoppers use your test store's native customer sign-in. There are no credentials to provide. Support: hi@busymate.ai

FIXES SINCE REVIEW 132497 (2026-09-11), live as app version 0.1.8 on 2026-09-13:
- 5.1.2: "Turn on the storefront assistant" opens the theme editor on the "Busymate AI assistant" app embed (no "App embed does not exist"); the widget renders in the Theme Editor preview and on the Online Store.
- 2.1.1: "Step 1: Assistant provisioned" no longer errors after plan changes (provisioning and activation repaired); any transient page error now recovers inside the app instead of showing a 500 page.

FIXES SINCE THE 2026-09-24 SUSPENSION (5.1.2 "refused to connect"): the chat frame is allowed in the Theme Editor and on the storefront as soon as the assistant is live, including right after an install or a reinstall; the launcher never opens a refused frame; the first message after a re-train is answered.

1. Install and open the app. Home shows the setup checklist and training counts (products, policies, pages). If an earlier install failed, click Retry setup. Confirm "Assistant provisioned" is Done and the status is Live.
2. Click "Turn on the storefront assistant" (it becomes available once your assistant can be shown, usually under a minute; the page checks by itself). The theme editor opens App embeds with "Busymate AI assistant" switched on: click Save. The embed stays on only after Save. Manual path: Online Store > Themes > Customize > App embeds.
3. Open "Ask us" in the Theme Editor preview and on the storefront. Ask about a product or policy from your test store; the answer uses that store's content.
4. Billing > Choose a plan opens Shopify's hosted pricing page. Select Free and approve the $0 plan; back in the app, check the plan (Refresh status if needed).
5. On a development store paid tiers are "Free to test": change to Growth, then Scale, then back to Free; the app returns each time and Home stays Live.
6. Assistant settings: change the assistant name, Save, then start a new storefront chat to see it. Store connection > Re-train on my store refreshes the knowledge.
7. Guests can ask product/policy questions without login. For order tests, create a test customer and order and use the store's customer sign-in. The assistant never discloses another customer's orders and asks for confirmation before any order-changing action.
8. Ask for a person to test the human handoff. Uninstall and reinstall the app; Home opens and the assistant is restored.

Support: hi@busymate.ai
