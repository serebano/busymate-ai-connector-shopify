// The canonical store record (public.store_apps on the Busymate platform) is the
// SINGLE SOURCE OF TRUTH for this app's listing content across every surface —
// busymate.ai/store, the Shopify listing, and this app's public landing. The
// landing renders FROM the record so edits there propagate here automatically;
// nothing user-visible is hand-maintained in this repo.
//
// Read path: the public anon read of store_apps (RLS `store_apps_select_public`,
// status='published') via PostgREST on the platform's public API host. The
// publishable key below is a PUBLIC client-embeddable key by Supabase design
// (it ships in every busymate.ai client bundle); it grants nothing beyond the
// public RLS policies. Both are overridable via env.

export type StoreListing = {
  slug: string;
  name: string;
  tagline: string;
  privacy_url: string | null;
};

export const STORE_APP_SLUG = "busymate-ai-shopify";

// Busymate AI's own Supabase project (api.busymate.ai) since the 2026-10-02 cutover;
// the devtools project (api.busymate.net) no longer owns store_apps.
export const STORE_API_URL =
  process.env.BUSYMATE_STORE_API_URL || "https://api.busymate.ai/rest/v1";
const STORE_API_KEY =
  process.env.BUSYMATE_STORE_API_KEY ||
  "sb_publishable_a_TcL2APiE7lF1lRe1NvOQ_ZLM30m8C";

// Fail-open fallback: a SNAPSHOT of the record's live values (sourced from
// store_apps 2026-09-02, app 1d27d3df-1703-4ed2-80a5-523f3028d54d) — used only
// when the store API is unreachable. Never invent copy here; refresh it from
// the record if it ever needs touching (test/storeListing.test.ts pins it to
// listing/en.json, which is drift-checked against the record).
const SNAPSHOT: StoreListing = {
  slug: STORE_APP_SLUG,
  name: "Busymate AI",
  tagline: "Grounded, order-aware AI support for your store",
  privacy_url: "https://store.busymate.ai/legal/privacy",
};

export function storePageUrl(listing: StoreListing): string {
  return `https://busymate.ai/store/apps/${listing.slug}`;
}

const TTL_MS = 5 * 60 * 1000;
let cache: { data: StoreListing; at: number } | null = null;

/** Public store-record read with a short in-memory TTL cache; serves the last
 * good value (or the committed snapshot) if the API is unreachable. */
export async function getStoreListing(): Promise<StoreListing> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const url =
      `${STORE_API_URL}/store_apps` +
      `?slug=eq.${STORE_APP_SLUG}&status=eq.published` +
      `&select=slug,name,tagline,privacy_url`;
    const res = await fetch(url, {
      headers: { apikey: STORE_API_KEY },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const rows = (await res.json()) as StoreListing[];
      const row = rows[0];
      if (row?.name && row?.tagline) {
        cache = { data: row, at: Date.now() };
        return row;
      }
    }
  } catch {
    // Unreachable/slow API → fall through to the last good value.
  }
  return cache?.data ?? SNAPSHOT;
}

/** Test seam. */
export function _resetStoreListingCache() {
  cache = null;
}
