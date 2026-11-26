/**
 * Prices in the shop's OWN money format (Shopify `shop.currencyFormats.moneyFormat`),
 * so a Philippine store reads "₱3,299.00" and not "3299.0 PHP", a euro store "3.299,00 €".
 * The raw Admin API returns `{ amount: "3299.0", currencyCode: "PHP" }`; the merchant's
 * format string (Settings › General › Standard / Currency formatting) is a Liquid-style
 * template such as "₱{{amount}}" or "{{amount_with_comma_separator}} €".
 *
 * Fail-soft: no format (query failed / unknown token) → the old "<amount> <CODE>" text,
 * so a price is never lost or wrong because the format could not be read.
 */
import type { ShopifyAdminClient } from "../mcp/shopifyAdmin";

export interface MoneyLike {
  amount?: string | null;
  currencyCode?: string | null;
}

export interface ShopMoneyFormat {
  /** e.g. "₱{{amount}}" */
  moneyFormat: string;
  /** The shop's own currency; the format only applies to this currency. */
  currencyCode: string | null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤", copy: "©" };

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);
}

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Shopify's `{{amount…}}` tokens (https://shopify.dev/docs/api/liquid/filters/money). */
function renderAmount(token: string, value: number): string | null {
  const noDec = token.includes("no_decimals");
  const fixed = Math.abs(value).toFixed(noDec ? 0 : 2);
  const [i = "0", d] = fixed.split(".");
  let thousands = ",";
  let decimal = ".";
  if (token.endsWith("with_comma_separator")) { thousands = "."; decimal = ","; }
  else if (token.endsWith("with_apostrophe_separator")) { thousands = "'"; decimal = "."; }
  else if (token.endsWith("with_space_separator")) { thousands = " "; decimal = ","; }
  else if (token.endsWith("with_period_and_space_separator")) { thousands = " "; decimal = "."; }
  else if (token !== "amount" && token !== "amount_no_decimals") return null;
  const body = group(i, thousands) + (d !== undefined ? decimal + d : "");
  return (value < 0 ? "-" : "") + body;
}

/** Format one Money value with the shop's money format; falls back to "<amount> <CODE>". */
export function formatMoney(m: MoneyLike | null | undefined, fmt?: ShopMoneyFormat | null): string | null {
  if (!m?.amount) return null;
  const raw = `${m.amount}${m.currencyCode ? ` ${m.currencyCode}` : ""}`;
  if (!fmt?.moneyFormat) return raw;
  // The merchant format is only valid for the shop currency (presentment money may differ).
  if (m.currencyCode && fmt.currencyCode && m.currencyCode !== fmt.currencyCode) return raw;
  const value = Number(m.amount);
  if (!Number.isFinite(value)) return raw;
  let ok = true;
  const out = decodeEntities(fmt.moneyFormat).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, token: string) => {
    const r = renderAmount(token, value);
    if (r === null) ok = false;
    return r ?? "";
  });
  return ok && /\d/.test(out) ? out.trim() : raw;
}

interface CacheEntry { at: number; fmt: ShopMoneyFormat | null }
const cache = new Map<string, CacheEntry>();
const OK_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;

/** The shop's money format, cached per shop for 10 min (1 min after a failed read). Never throws. */
export async function loadMoneyFormat(admin: ShopifyAdminClient): Promise<ShopMoneyFormat | null> {
  const hit = cache.get(admin.shop);
  if (hit && Date.now() - hit.at < (hit.fmt ? OK_TTL_MS : MISS_TTL_MS)) return hit.fmt;
  let fmt: ShopMoneyFormat | null = null;
  try {
    const data = (await admin.graphql(
      `#graphql
      query ShopMoneyFormat { shop { currencyCode currencyFormats { moneyFormat } } }`,
    )) as { shop?: { currencyCode?: string | null; currencyFormats?: { moneyFormat?: string | null } | null } | null };
    const f = data?.shop?.currencyFormats?.moneyFormat;
    if (typeof f === "string" && f.includes("{{")) fmt = { moneyFormat: f, currencyCode: data?.shop?.currencyCode ?? null };
  } catch {
    fmt = null;
  }
  cache.set(admin.shop, { at: Date.now(), fmt });
  return fmt;
}

/** Test hook. */
export function clearMoneyFormatCache(): void {
  cache.clear();
}
