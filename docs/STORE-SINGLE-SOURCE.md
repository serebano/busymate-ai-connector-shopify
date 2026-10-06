# Single source of truth for listing content

This app's listing content — name, tagline, description, features, **pricing plans**, media,
category, locales — lives in **one canonical record** in the Busymate control plane
(`public.store_apps` + children), not in this repo and not hand-maintained per surface. Everything
here **derives** from it. Program: the internal platform tracker.

## Read it: the shared public endpoint

```
GET https://busymate.ai/api/store/apps/busymate-ai-shopify
```

Public (published apps only), no auth, `Access-Control-Allow-Origin: *`, short CDN cache. The body is
the SAME `StoreAppDetailResult` the `busymate.ai/store` page renders from (`app` + siblings; storage
paths already resolved to public URLs; `reviews` and the connector manifest omitted):

```jsonc
{
  "app": {
    "slug": "busymate-ai-shopify", "name": "Busymate AI",
    "tagline": "…", "descriptionMd": "…", "iconUrl": "…",
    "installKind": "connector", "pricingModel": "usage",
    "homepageUrl": "…", "privacyUrl": "…", "badges": [],
    "installCount": 0, "ratingAvg": 0, "ratingCount": 0
  },
  "developer": { "slug": "busymate", "displayName": "Busymate", "verified": true },
  "category": { "slug": "sales-support", "name": "Sales & Support" },
  "media": [ { "kind": "screenshot", "url": "…", "alt": "…", "position": 1 } ],
  "plans": [ { "kind": "free", "name": "Free", "amountCents": 0, "currency": "usd",
               "interval": "month", "features": ["…"] } ],
  "version": { "version": "1.0.0", "changelogMd": "…" }
}
```

The **public root** (`app/routes/_index.tsx`, served at `store.busymate.ai/`) should render from this —
the SAME record the `busymate.ai/store` page renders from, so the two surfaces are identical by
construction. Fetch it in the loader (with `BMAI_STORE_ENDPOINT` overridable for staging):

```ts
const res = await fetch(process.env.BMAI_STORE_ENDPOINT
  ?? "https://busymate.ai/api/store/apps/busymate-ai-shopify");
const { app, developer, category, media, plans, version } = await res.json();
```

Do **not** hardcode the copy or prices into a component — that reintroduces the drift this removes.

## The Shopify App Store listing (Partner Dashboard)

Shopify exposes **no API/CLI** to write listing copy, screenshots, or Managed Pricing — those are
hand-entered in the Partner Dashboard (verified; see the devtools `docs/architecture/store-single-source.md`).
Only `shopify.app.toml` config (name, URLs, scopes, webhooks) auto-pushes via `shopify app deploy`.

So this repo keeps **derived source-of-record** artifacts a human copies into the Dashboard, and a
**drift-check** guarantees they never silently fall out of step with the canonical record:

- `npm run listing:sync` — regenerate `listing/pricing.json` (the Managed-Pricing source-of-record)
  and the `shopify.app.toml` `name` from the canonical record.
- `npm run drift-check` — compare the live canonical record against the repo artifacts; **exit 1**
  on drift, **exit 2** if the endpoint is unreachable (UNVERIFIED — never a silent pass). Runs in CI
  as an advisory step; the comparison logic is unit-tested (`test/listing-drift.test.ts`).

**Flow to change content:** edit the `store_apps` record (via a `store_*` MCP tool / RPC) → surfaces
1 & 2 update on next read → run `npm run listing:sync`, commit, hand-apply pricing + copy in the
Partner Dashboard → `npm run drift-check` proves it matches.
