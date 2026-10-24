/**
 * Is the store's Online Store open to the public? (busymate-ai-src#2704, Shopify
 * review S4.)
 *
 * While the storefront is password-protected the store is NOT public, so its
 * assistant must not have a public page either: the app publishes the tenant
 * with `hosted_web: false`, which removes `shop-<store>.busymate.ai` and keeps
 * `/support/<slug>` only as the storefront widget's frame. Shoppers who passed
 * Shopify's password page still get the widget on the storefront itself.
 *
 * Two independent reads, the first definite answer wins:
 *   1. Admin GraphQL `onlineStore.passwordProtection.enabled` (Shopify's own flag);
 *   2. the public storefront: a redirect to `/password` (or the password form) =
 *      protected, a 200 storefront = public. Scope-free.
 * `null` = neither could answer. Callers FAIL CLOSED on null (no public page):
 * the widget keeps working either way, and the next read repairs it.
 */

export type AdminGraphql = (query: string) => Promise<unknown>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const STOREFRONT_LOCK_QUERY = `#graphql
  query StorefrontPassword { onlineStore { passwordProtection { enabled } } }`;

/** Admin read: true = protected, false = open, null = could not tell. Never throws. */
export async function readPasswordProtectionAdmin(graphql: AdminGraphql | null | undefined): Promise<boolean | null> {
  if (!graphql) return null;
  try {
    const data = (await graphql(STOREFRONT_LOCK_QUERY)) as { onlineStore?: { passwordProtection?: { enabled?: unknown } | null } | null } | null;
    const enabled = data?.onlineStore?.passwordProtection?.enabled;
    return typeof enabled === "boolean" ? enabled : null;
  } catch {
    return null;
  }
}

/** Public storefront read: true = protected, false = open, null = could not tell. Never throws. */
export async function probePasswordProtection(shop: string, doFetch: Fetch = fetch): Promise<boolean | null> {
  try {
    const res = await doFetch(`https://${shop}/`, {
      redirect: "manual",
      headers: { accept: "text/html", "user-agent": "BusymateAI-Shopify-App/1.0 (+https://store.busymate.ai)" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      let path = "";
      try { path = new URL(location, `https://${shop}/`).pathname; } catch { return null; }
      return /^\/password\/?$/.test(path) ? true : null;
    }
    if (res.status !== 200) return null;
    const html = await res.text();
    return /<form[^>]+action="\/password"/i.test(html);
  } catch {
    return null;
  }
}

/** True = public, false = password-protected, null = unknown. */
export async function storefrontIsPublic(
  shop: string,
  graphql: AdminGraphql | null | undefined,
  doFetch: Fetch = fetch,
): Promise<boolean | null> {
  const admin = await readPasswordProtectionAdmin(graphql);
  if (admin !== null) return !admin;
  const probe = await probePasswordProtection(shop, doFetch);
  return probe === null ? null : !probe;
}

/** The `hosted_web` a publish carries: a public page only for a store that is definitely public. */
export function hostedWebFor(isPublic: boolean | null): boolean {
  return isPublic === true;
}
