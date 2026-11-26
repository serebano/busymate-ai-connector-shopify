<!-- Paste source for the private Partner Dashboard "Testing instructions" field (2800 chars max; the text below is 2745).
     Matches app version busymate-ai-12 + the live server; every step was done by hand on the dev store
     v12-review-1126 on 2026-11-26. Never commit credentials here. -->
ACCESS
No Busymate AI account, password, SSO or two-factor login is needed; everything runs inside Shopify Admin; you create the test customer yourself (step 6). Support: hi@busymate.ai.

REVIEW FLOW (development store with products and one policy; Shopify test data is enough)
1. Install. Home opens and, within about a minute and without a reload, shows "Assistant provisioned: Done" and "Trained on your store: Done".
2. Home > "Turn on the storefront assistant" opens the theme editor with the app embed "AI support chat" on (manual: Online Store > Themes > Customize > App embeds). Click Save. Back in the app, Home shows "Storefront assistant is on" with no reload or confirmation, also on a password-protected store.
3. Assistant settings: change Assistant name and Store display name; a save bar appears; click Save. A toast confirms and a reload shows the saved values.
4. Store connection: "Re-train on my store" shows "Trained on ...".
5. On the storefront (password if asked) click "Ask us" and ask about a product. The assistant answers from your catalog under the name from step 3. New or just-edited products can take a few minutes to appear in answers.
6. Signed-in shopper. In Admin create a test customer with an email you can read and a default address (Customers > Add customer), then Customers > Create order: add a product, Collect payment > Mark as paid. On the storefront click the "Log in" icon (header; in the menu on mobile), enter that email and the code Shopify emails you. Ask "Where is my latest order?": it answers with that customer's own order and status.
7. Ask to change the shipping address: give the order number and the full new address (street, city, ZIP, country). A confirmation card shows both; only after Approve does the assistant change it in Shopify. Cancel changes nothing. Cancelling an unfulfilled order works the same way. Returns and refunds go to your team.
8. Ask "I'd like to talk to a person". A guest presses "Send to the team"; a signed-in shopper is passed on at once. In the app: Conversations > Open conversation > "Claim and pause assistant", type a reply, "Send reply" (it appears in the shopper's chat), then "Resolve and resume assistant"; the assistant answers the next message.
9. Billing > Choose a plan opens Shopify's pricing page. Free ($0): Select, Approve; Billing shows Free: 25 AI resolutions a month, then conversations go to your team. Starter, Growth and Scale have a 14-day free trial; on a development store choose "Test with this plan", Approve (no charge). Cancel on Shopify's page keeps the current plan.
10. Uninstall: Settings > Apps > Busymate AI > ... > Uninstall. Reinstall: setup completes by itself; Billing shows "No plan selected" until you choose one.
