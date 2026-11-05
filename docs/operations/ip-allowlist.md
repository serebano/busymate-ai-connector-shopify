# Shopify Admin API IP allowlist

Shopify requires every public app that calls the Admin API to have an IP allowlist with
enforcement on: bulk operations fail without one after **2026-11-12**, and apps without one
are delisted and blocked from new installs after **2026-11-20** (Shopify Partner email,
2026-11-05). With enforcement on, Shopify refuses any call that carries this app's tokens
from an address outside the list.

**Source of truth:** [`config/admin-api-egress-allowlist.json`](../../config/admin-api-egress-allowlist.json).
The Dev Dashboard list (Dev Dashboard → Busymate AI → Settings → IP allowlist) must equal
that file, entry for entry.

## What calls the Admin API (measured 2026-11-05)

| Caller | Kind (k8s ns `bmai`) | Admin API use | Node | Egress |
| --- | --- | --- | --- | --- |
| `shopify-app` (×2) | Deployment | embedded admin loaders/actions, `/mcp` connector tools (products, orders, refunds, returns, discounts), webhooks, billing sync | efirs (pinned) | `141.95.126.194` |
| `shopify-kb-reingest` | Deployment | knowledge re-train worker (products, policies, pages) | efirs (pinned) | `141.95.126.194` |
| `shopify-kb-freshness` | CronJob `37 0,6,12,18 * * *` | 72 h knowledge backstop, `shop.json` probe | efirs (pinned) | `141.95.126.194` |
| `shopify-meter` | CronJob `17 * * * *` | usage billing records | efirs (pinned) | `141.95.126.194` |

- All four run the `ghcr.io/serebano/busymate-ai-shopify` image with
  `nodeSelector: kubernetes.io/hostname: efirs` (busymate-ai-infra `base/app/`).
- Pod egress is SNAT to the node's public IPv4. There is no egress proxy and no
  `HTTP(S)_PROXY` setting, and the pods have no IPv6. The efirs host does have IPv6
  (`2001:41d0:700:69c2::/56`), but pod traffic never uses it. Measured from inside each
  running pod with `curl -4/-6` against `api.ipify.org`, `ifconfig.me` and `icanhazip.com`:
  IPv4 `141.95.126.194` everywhere, IPv6 none.
- **No bulk operations:** the code has no `bulkOperationRunQuery` or
  `bulkOperationRunMutation`, so the 2026-11-12 deadline does not apply. The 2026-11-20
  deadline does.
- Nothing else calls the Admin API with this app's tokens. busymate-ai-src (web, agent,
  Supabase edge functions) reaches Shopify only through this app's MCP connector, per the
  all-ops-via-MCP rule. `partners.shopify.com` (Partner API, `app/lib/partnerApi.ts`) is not
  the Admin API.

## Sources the 30-day test is expected to show

| Address | What | Allowlist? |
| --- | --- | --- |
| `141.95.126.194` | efirs: every current caller | **yes** |
| `142.93.32.78` | busymate-v2-lon1 (DigitalOcean): the app host until the k8s cutover on 2026-10-17 06:04Z; retired | **no**: historical only. Its traffic must end by 2026-10-17 |
| developer machines | `shopify app dev` or ops scripts run by hand | **no**: run ops scripts in a pod on efirs (`kubectl exec`) |

If the test reports any other source, or traffic from `142.93.32.78` after 2026-10-17, stop
and investigate before turning enforcement on.

## Changing egress (node move, NAT, new host)

1. Add the new address to `config/admin-api-egress-allowlist.json` through a PR, **and** to
   the Dev Dashboard list, **before** any Admin API caller moves.
2. Move the workloads.
3. Check that `GET https://store.busymate.ai/api/egress/health` returns 200 `green` with
   the new address.
4. Remove the old address from both places.

## The guard

`GET /api/egress/health` (`app/routes/api.egress.health.tsx`, logic in
`app/lib/egressAllowlist.ts`) asks three echo services for the pod's public address and
compares the answers with the repo list:

- **200 `green`**: at least two services agree, and every observed address is in the list.
- **503 `red`**: an observed address is outside the list (egress moved).
- **503 `unverified`**: fewer than two services answered. This fails closed and is never
  reported as green.

The result is cached for 5 minutes. The review-surface probe (busymate-ai-infra
`base/review-probe`, check `shopify/admin-api-egress`) reads it every 15 minutes, so a red
fires `ReviewSurfaceDown` to the ops Telegram. The app pod shares the node and egress path
of every other caller, so its address is theirs.

## Dev Dashboard status

| Date | Step | Result |
| --- | --- | --- |
| 2026-11-05 | Callers and egress measured (above) | `141.95.126.194/32` |
| pending | Add `141.95.126.194/32`, Run test (30 days) | owner sign-in to the Dev Dashboard needed (passkey/Apple) |
| pending | Enforcement on and Save, only when the only uncovered source is the retired `142.93.32.78` before 2026-10-17 | |
