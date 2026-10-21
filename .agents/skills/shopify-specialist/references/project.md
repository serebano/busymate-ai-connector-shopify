# Project map and delivery

## Source map

| Surface | Repository sources |
| --- | --- |
| Managed install, session tokens, expiring offline tokens | `app/shopify.server.ts`, `app/lib/encryptedSessionStorage.ts`, `app/lib/cycleOfflineTokens.ts` |
| Provision, branding, knowledge, connector registration, publish | `app/bmai.server.ts`, `app/lib/provision.ts`, `app/lib/mgmtArgs.ts`, `app/lib/kbTrain.ts`, `app/lib/kbSnapshot.ts` |
| Embedded React Router 7 admin | `app/routes/app*.tsx`, `app/components/PolarisLink.tsx`, `app/components/AppRouteError.tsx`, `app/lib/clientAction.ts` |
| Theme activation and storefront widget | `app/lib/themeEmbed.ts`, `extensions/storefront-assistant/blocks/assistant.liquid`, `extensions/storefront-assistant/assets/assistant.js` |
| Shopify App Pricing and usage | `app/lib/plans.ts`, `app/lib/partnerApi.ts`, `app/lib/billingSync.ts`, `app/lib/billingGate.ts`, `app/lib/appEvents.ts`, `app/lib/usageBilling.ts`, `app/routes/app.billing.tsx`, `listing/pricing.json` |
| Customer identity and delegated actions | `app/routes/identity.tsx`, `app/lib/storefrontIdentity.ts`, `app/lib/identity.ts`, `app/mcp/` |
| Compliance and uninstall | `app/routes/webhooks.compliance.tsx`, `app/routes/webhooks.app.uninstalled.tsx`, `app/lib/compliance.ts` |
| Runtime/configuration | `shopify.app.toml`, `package.json`, `prisma/schema.prisma`, `.github/workflows/`, `SETUP.md` |

Read `docs/ARCHITECTURE.md`, `docs/PROVISIONING.md`, and `docs/EXTENDING.md` for lifecycle details, and `docs/STORE-SINGLE-SOURCE.md` before changing listing or legal material. Do not copy platform logic into this client.

## Fragile contracts

- Theme activation uses the installed app's **client ID** plus `/assistant`. The extension's CDN UUID is for asset detection, not activation. Without app identity, use the manual App embeds panel. A password-protected storefront is `unknown`, not proof that the embed is disabled.
- Provisioning must register a connector acceptable to delegated-tool preflight before publishing. Use shared management argument builders with proof-of-shop; errors must survive into observable setup status. Knowledge goes through `knowledge_sources`.
- Keep internal admin links router-aware, external theme/billing links top-level, and action transport failures recoverable inside the app frame. Do not convert a missing session or transport failure into success.
- Distinguish **no plan selected** from a selected $0 Free contract. Read actual subscription state, not merely a return URL or successful navigation. Verify the current App Pricing integration before changing legacy Billing API code.
- Preserve token refresh through the Shopify library and encrypted session storage. A dashboard's trailing deprecated-token warning is not by itself evidence of a new rejected API call.

## Code and release proof

Use Node supported by `package.json`; run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` per contributor guidance. Add meaningful failure-path regression tests for behavioral fixes. Relevant suites include `reviewProvision`, `themeEmbed`, `billingSync`, `billingGate`, `partnerApi`, `clientAction`, and `shopifyConfig` under `test/`.

Check the working tree and remote ancestry before editing; preserve unrelated work. Keep host release and Shopify app release separate: `npm run deploy` releases Shopify configuration/extensions, not the Node application host. Read the current `SETUP.md` and deployed service configuration; repository comments have used both `store.busymate.ai` and `shopify.busymate.ai`, so verify the configured public origin instead of assuming either.

For authorized host deployment, establish the exact revision, prior rollback revision, migration compatibility, environment ownership, build result, and service health. Read secrets inside the authorized process; never print environment files or interpolate secret values into argv, logs, or committed scripts. Prefer existing secret-loading paths; when an external program needs a secret, pass it through stdin or its supported protected descriptor. Do not copy production credentials to the checkout. Verify the public embedded and storefront journeys after restart, not only a loopback HTTP response.
