<!-- Paste source for the private Partner Dashboard "Testing instructions" field (2800 chars max).
     Every sentence is true on the live app and was walked on a fresh dev store (busymate-ai-src#2624,
     .coordination/audits/shopify-resubmit-2026-11-22.md). Never commit credentials here. -->
ACCESS
No Busymate AI account or password is needed; everything runs inside Shopify Admin. Guests can ask product and policy questions; order questions use the store's own customer sign-in. Support: hi@busymate.ai.

REVIEW FLOW (development store with products, one policy, and a test customer with a paid order)
1. Install. Home opens and, within about 10 seconds and without a reload, shows "Assistant provisioned: Done" and "Trained on your store: Done".
2. Billing > Choose a plan opens Shopify's pricing page. Approve any plan (a dev store gets a $0 test charge); Billing then shows that plan. Cancel on Shopify's approval page keeps the current plan. Refresh status re-reads the plan from Shopify.
3. Assistant settings: change Assistant name and Store display name, then Save. A toast confirms "saved and published"; a reload shows the saved values. If the assistant name is "your mate" (Busymate AI's own assistant), the app saves "<Store display name> AI" and says so.
4. Store connection: "Re-train on my store" shows "Trained on ..." and "Reconnect" shows "Store connection is live".
5. Home > Open App embeds: switch on "Busymate AI assistant" and Save. On a password-protected store Home cannot check the storefront; choose "It's switched on" and the step shows Done.
6. In the theme editor preview and in the Online Store (storefront password if asked), open "Ask us" and ask about a product. The assistant uses the name from step 3 and answers from your catalog.
7. Sign in as the test customer (storefront account icon, email code). Ask "Where is my latest order?"; it answers with that customer's own order and status. {{ORDER_CHANGE_STEP}}
8. Ask "I'd like to talk to a person" and press Send request. In the app open Conversations > Open conversation: "Claim and pause assistant", type a reply and "Send reply" (it appears in the shopper's chat), then "Resolve and resume assistant"; the assistant answers the next message. "Read assistant chat" on Conversations opens any transcript inside Shopify.
9. Uninstall, then reinstall: setup completes by itself; saved names and the theme embed remain.

The private plan "shopify-test" is Shopify's built-in $0 test plan; no store has access to it.
