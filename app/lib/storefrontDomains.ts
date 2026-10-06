/**
 * The store's REAL storefront domains → embed origins (#3718, Shopify review 5.1.2).
 *
 * A shopper on a merchant's custom domain (`https://www.example.com`) loads the
 * storefront from THAT origin, and the chat frame's `frame-ancestors` is checked
 * against it. The app only ever allowlisted `https://<shop>.myshopify.com` (the
 * `customDomain` column existed but nothing filled it), so every merchant with a
 * custom domain would see "busymate.ai refused to connect" on the live store.
 *
 * The domains are read from the Admin API at provisioning (the primary domain is
 * always available; the full list is best-effort because Shopify has been moving
 * domain data between API surfaces) and stored — comma-separated — in the
 * existing `ShopTenant.customDomain` column, so every later publish (re-train,
 * reinstall, the provisioning sweep) carries them without a schema migration.
 *
 * Only concrete public hostnames survive: no wildcard, no port, no path, no
 * `*.myshopify.com` (the shop origin is always added separately), capped.
 */
import type { ShopifyAdminClient } from "../mcp/shopifyAdmin";

/** The most storefront domains carried into one tenant's allowlist. */
export const MAX_STOREFRONT_DOMAINS = 10;

export const PRIMARY_DOMAIN_QUERY = `#graphql
  query StorefrontPrimaryDomain { shop { primaryDomain { host } } }`;

export const ALL_DOMAINS_QUERY = `#graphql
  query StorefrontDomains { shop { domains { host } } }`;

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A bare, lower-case public hostname, or null for anything else. */
export function normalizeStorefrontHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("*") || !HOSTNAME.test(host)) return null;
  if (host === "myshopify.com" || host.endsWith(".myshopify.com")) return null;
  return host;
}

/** De-duplicated, validated, capped host list (input order kept, primary first). */
export function storefrontHosts(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const host = normalizeStorefrontHost(value);
    if (host && !out.includes(host)) out.push(host);
    if (out.length >= MAX_STOREFRONT_DOMAINS) break;
  }
  return out;
}

/** The stored column value (one host, or a comma/space-separated list) → hosts. */
export function parseStoredDomains(stored: string | null | undefined): string[] {
  return storefrontHosts(String(stored ?? "").split(/[\s,]+/));
}

/** Hosts → the column value. */
export function formatStoredDomains(hosts: readonly string[]): string | null {
  const clean = storefrontHosts(hosts);
  return clean.length ? clean.join(",") : null;
}

/**
 * Read the storefront's domains through the Admin API. The primary domain is
 * load-bearing for this read (a failure throws, the caller treats it as soft);
 * the full list is best-effort and never fails the read.
 */
export async function fetchStorefrontHosts(admin: Pick<ShopifyAdminClient, "graphql">): Promise<string[]> {
  const primary = (await admin.graphql(PRIMARY_DOMAIN_QUERY)) as { shop?: { primaryDomain?: { host?: string } | null } | null } | null;
  const hosts: unknown[] = [primary?.shop?.primaryDomain?.host];
  try {
    const all = (await admin.graphql(ALL_DOMAINS_QUERY)) as { shop?: { domains?: Array<{ host?: string }> | null } | null } | null;
    for (const d of all?.shop?.domains ?? []) hosts.push(d?.host);
  } catch {
    // Best-effort: the primary domain alone still covers the storefront shoppers use.
  }
  return storefrontHosts(hosts);
}
