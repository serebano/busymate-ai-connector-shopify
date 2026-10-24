/**
 * Store → `knowledge_sources` compressor (#2110 grounding).
 *
 * The Busymate AI platform's ONE tenant-knowledge write path is
 * `publish_tenant_runtime.knowledge_sources`: ≤40 sources, key
 * `^[a-z0-9][a-z0-9:._-]{0,119}$` (re-publishing a key REPLACES it), kind
 * fact|howto|reference|glossary, plain-text `content` 1..20,000 chars per source
 * and ≤40,000 chars TOTAL per call. Anything over is refused at the edge (no
 * partial publish), so this module is DETERMINISTIC and never exceeds the limits:
 * the same store snapshot always compresses to the same bytes, most-important
 * content first (policies → products → pages), truncating at whole-item
 * boundaries with an explicit "+N more" note the assistant can read.
 *
 * Pure: no I/O. `app/lib/kbFetch.ts` fetches the snapshot from the Admin API;
 * `app/lib/kbTrain.ts` publishes the result and persists the training state.
 */

import { onOnlineStore, storefrontProductUrl } from "./onlineStore";

export interface KbMoney {
  amount?: string | null;
  currencyCode?: string | null;
}

export interface KbProduct {
  title?: string | null;
  handle?: string | null;
  status?: string | null;
  descriptionHtml?: string | null;
  onlineStoreUrl?: string | null;
  /** When the product was published to the Online Store (null = not published there). */
  publishedAt?: string | null;
  productType?: string | null;
  vendor?: string | null;
  priceRangeV2?: { minVariantPrice?: KbMoney | null; maxVariantPrice?: KbMoney | null } | null;
  compareAtPriceRange?: { minVariantCompareAtPrice?: KbMoney | null } | null;
}

export interface KbPolicy {
  type?: string | null;
  title?: string | null;
  body?: string | null;
  url?: string | null;
}

export interface KbPage {
  title?: string | null;
  handle?: string | null;
  body?: string | null;
}

export interface KbSnapshot {
  /** `<store>.myshopify.com` — used for page URLs when the API gives none. */
  shop: string;
  shopName?: string | null;
  products: KbProduct[];
  policies: KbPolicy[];
  pages: KbPage[];
  generatedAt: string;
}

export type KnowledgeKind = "fact" | "howto" | "reference" | "glossary";

/** ONE item of the platform's `knowledge_sources` array. */
export interface KnowledgeSource {
  key: string;
  label: string;
  kind: KnowledgeKind;
  content: string;
}

export interface KnowledgeLimits {
  perSourceChars: number;
  totalChars: number;
  maxSources: number;
}

/** The platform limits (publish_tenant_runtime.knowledge_sources contract). */
export const KNOWLEDGE_LIMITS: KnowledgeLimits = { perSourceChars: 20_000, totalChars: 40_000, maxSources: 40 };

/** Stable keys — re-publishing a key REPLACES that source on the platform. */
export const KNOWLEDGE_KEYS = {
  orderHelp: "shopify:order-help",
  policies: "shopify:policies",
  products: "shopify:products",
  pages: "shopify:pages",
} as const;

/**
 * The store's "order help in this chat" how-to (#2132 FAIL B). Grounded knowledge
 * the assistant can cite when a shopper asks about THEIR order: signed-in shoppers
 * get status/tracking (and, after they approve, a cancellation or an address change) in chat through the store connection;
 * a shopper who is NOT signed in is told to use the Sign in control at the top of
 * the chat (or the store's account login) and ask again, and can ask for a human.
 * Rendered FIRST and reserved out of the budget, so a huge catalog never starves it.
 */
/**
 * src#2624 review S7 — "What is your return policy?" was answered "Returns and refunds are
 * handled by the store's team … connect you with a person?" on a store that has published
 * NO return policy: the how-to's only line about returns was a hand-off, so the shopper
 * never learned the fact. The policy line is now the FACT, decided in code from the
 * store's own policies: the published refund policy (under "Store policies"), or plainly
 * that none is published.
 */
export function hasReturnPolicy(policies: readonly KbPolicy[]): boolean {
  return policies.some((p) => (p.type ?? "").toUpperCase() === "REFUND_POLICY" && htmlToText(p.body).trim().length > 0);
}

export function returnPolicyLine(storeName: string, published: boolean): string {
  return published
    ? `Return and refund policy: ${storeName} has published one; it is under "Store policies" — answer a returns question from it. Starting a return or a refund for a specific order is done by the store's team: offer to connect the customer with a person for that.`
    : `Return and refund policy: ${storeName} has NOT published a return or refund policy. When asked about returns, refunds or exchanges, say plainly that the store has not published a return policy, then offer to connect the customer with a person who can answer for their order.`;
}

export function renderOrderHelp(shop: string, storeName: string, policies: readonly KbPolicy[] = []): string {
  const login = `https://${shop}/account/login`;
  return [
    `# Order help in this chat — ${storeName} (${shop})`,
    "Order status and tracking are handled in this chat for signed-in customers only, and only for that customer's own orders; a signed-in customer does not need to give an order number for their most recent order. After the customer approves, the assistant can cancel an unfulfilled order or change the shipping address of an order that has not shipped.",
    returnPolicyLine(storeName, hasReturnPolicy(policies)),
    `If you are not signed in, you have two options: sign in with the "Sign in" button at the top of this chat (or at ${login}) and then ask again — for example "Where is my order #1001?" — or ask to talk to a human and the store's team will help you with your order. Always offer both.`,
    "Changes such as cancelling an order or updating a shipping address are confirmed with you in the chat before anything happens.",
    "Prefer a person at any point? Ask to talk to a human and the request goes to the store's team.",
  ].join("\n\n");
}

export interface KnowledgeCounts {
  products: number;
  policies: number;
  pages: number;
}

export interface KnowledgeBuild {
  sources: KnowledgeSource[];
  /** Items INCLUDED in the published knowledge (what the assistant was trained on). */
  counts: KnowledgeCounts;
  /** Items the store has (fetched) — `counts` < `fetched` means truncation. */
  fetched: KnowledgeCounts;
  totalChars: number;
  truncated: boolean;
}

// Per-item text caps keep every block bounded so whole items can be packed.
const PRODUCT_DESCRIPTION_CHARS = 240;
const POLICY_BODY_CHARS = 6_000;
const PAGE_BODY_CHARS = 1_500;

// Preferred share of the total budget per section (importance order). Leftover
// from an earlier section flows to the next; a later section's preferred share
// is RESERVED so a huge catalog can never starve the policies.
const PREFERRED_SHARE = { policies: 0.3, products: 0.5, pages: 0.2 } as const;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  euro: "€",
  pound: "£",
  yen: "¥",
};

/** HTML → plain text: no tags, entities decoded, whitespace collapsed, one line per block. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre|dd|dt|dl|figure|figcaption)\s*>/gi, "\n");
  s = s.replace(/<\s*(li|tr|p|div|h[1-6])\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
  s = s.replace(/\u00a0/g, " ");
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Cut text to `max` chars at a word boundary, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const head = text.slice(0, max - 1);
  const at = head.lastIndexOf(" ");
  return (at > max * 0.6 ? head.slice(0, at) : head).trimEnd() + "…";
}

function money(m: KbMoney | null | undefined): string | null {
  if (!m?.amount) return null;
  return `${m.amount}${m.currencyCode ? ` ${m.currencyCode}` : ""}`;
}

function humanizePolicyType(type: string | null | undefined): string | null {
  if (!type) return null;
  const t = type.toLowerCase().replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Only products a shopper can open are knowledge: published to the ONLINE STORE
 * (app/lib/onlineStore.ts). A DRAFT or ARCHIVED product is merchant-internal
 * (seen live: "The Draft Snowboard — not published"), and an ACTIVE product on no
 * channel or only on POS has no storefront page (src#2624 review X2: "The Hidden
 * Snowboard" was recommended with a 404 link). Re-training REPLACES the catalog
 * source by key, so a re-train also purges such a product from the trained index.
 */
export function isSellable(p: KbProduct): boolean {
  return onOnlineStore(p);
}

function renderProduct(p: KbProduct, shop: string): string | null {
  const title = (p.title ?? "").trim();
  if (!title) return null;
  const lines = [`Product: ${title}`];
  const min = money(p.priceRangeV2?.minVariantPrice);
  const max = money(p.priceRangeV2?.maxVariantPrice);
  if (min) lines.push(`Price: ${max && max !== min ? `from ${min} to ${max}` : min}`);
  // src#2624 reviewer F13 — the "was" price, so "what's on sale?" is answered from the catalog.
  const was = p.compareAtPriceRange?.minVariantCompareAtPrice;
  if (min && was?.amount && Number(was.amount) > Number(p.priceRangeV2?.minVariantPrice?.amount)) lines.push(`On sale: yes (compare-at price ${money(was)})`);
  const meta: string[] = [];
  if (p.productType) meta.push(`Type: ${p.productType}`);
  if (p.vendor) meta.push(`Vendor: ${p.vendor}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (p.handle) lines.push(`Handle: ${p.handle}`);
  const url = storefrontProductUrl(shop, p);
  if (url) lines.push(`URL: ${url}`);
  const desc = clip(htmlToText(p.descriptionHtml).replace(/\n+/g, " "), PRODUCT_DESCRIPTION_CHARS);
  if (desc) lines.push(`Description: ${desc}`);
  return lines.join("\n");
}

function renderPolicy(p: KbPolicy): string | null {
  const title = (p.title ?? humanizePolicyType(p.type) ?? "").trim();
  const body = clip(htmlToText(p.body), POLICY_BODY_CHARS);
  if (!title && !body) return null;
  const lines = [`## ${title || "Policy"}`];
  const kind = humanizePolicyType(p.type);
  if (kind && kind.toLowerCase() !== title.toLowerCase()) lines.push(`Type: ${kind}`);
  if (p.url) lines.push(`URL: ${p.url}`);
  lines.push(body || "(no text set)");
  return lines.join("\n");
}

function renderPage(p: KbPage, shop: string): string | null {
  const title = (p.title ?? "").trim();
  if (!title) return null;
  const lines = [`## ${title}`];
  if (p.handle) lines.push(`URL: https://${shop}/pages/${p.handle}`);
  const body = clip(htmlToText(p.body), PAGE_BODY_CHARS);
  if (body) lines.push(body);
  return lines.join("\n");
}

interface Section {
  id: keyof KnowledgeCounts;
  key: string;
  label: string;
  kind: KnowledgeKind;
  header: string;
  items: string[];
  noun: string;
  /** Rows the store has (for the "N of M" state). */
  fetched: number;
  /** Rows eligible to be knowledge (fetched minus products not on the Online Store). */
  renderable: number;
}

const SEP = "\n\n";

/** Pack whole items under `cap` chars; when not all fit, append a "+N more" note. */
function pack(section: Section, cap: number): { content: string; included: number } {
  const { header, items } = section;
  if (items.length === 0 || cap <= header.length) return { content: "", included: 0 };
  const note = (n: number) => `${SEP}(+${n} more ${section.noun} not included here — offer to check the store for anything else.)`;
  const parts: string[] = [];
  let used = header.length;
  for (const item of items) {
    const extra = (parts.length ? SEP.length : 0) + item.length;
    if (used + extra > cap) break;
    parts.push(item);
    used += extra;
  }
  if (parts.length === 0) {
    // Nothing fits whole — keep the FIRST item, hard-cut (policies are few and
    // partial text beats absence).
    const room = cap - header.length;
    if (room < 40) return { content: "", included: 0 };
    return { content: header + clip(items[0], room), included: 1 };
  }
  if (parts.length < items.length) {
    // Make room for the note, dropping trailing items if needed.
    while (parts.length > 0 && used + note(items.length - parts.length).length > cap) {
      const dropped = parts.pop()!;
      used -= dropped.length + (parts.length ? SEP.length : 0);
    }
    if (parts.length === 0) return { content: "", included: 0 };
    return { content: header + parts.join(SEP) + note(items.length - parts.length), included: parts.length };
  }
  return { content: header + parts.join(SEP), included: parts.length };
}

/**
 * Compress a store snapshot into the platform's `knowledge_sources` array within
 * `limits`. Deterministic; policies → products → pages; whole items; never over.
 */
export function buildKnowledgeSources(snapshot: KbSnapshot, limits: KnowledgeLimits = KNOWLEDGE_LIMITS): KnowledgeBuild {
  const shop = snapshot.shop;
  const storeName = (snapshot.shopName ?? "").trim() || shop;
  // Only Online Store products (src#2624 X2), in API order.
  const products = snapshot.products.filter(isSellable);

  const sections: Section[] = [
    {
      id: "policies",
      key: KNOWLEDGE_KEYS.policies,
      label: "Store policies",
      kind: "reference",
      header: `# Store policies — ${storeName} (${shop})${SEP}`,
      items: snapshot.policies.map(renderPolicy).filter((x): x is string => Boolean(x)),
      noun: "policies",
      fetched: snapshot.policies.length,
      renderable: snapshot.policies.length,
    },
    {
      id: "products",
      key: KNOWLEDGE_KEYS.products,
      label: "Product catalog",
      kind: "fact",
      header: `# Product catalog — ${storeName} (${shop})${SEP}`,
      items: products.map((p) => renderProduct(p, shop)).filter((x): x is string => Boolean(x)),
      noun: "products",
      fetched: snapshot.products.length,
      renderable: products.length,
    },
    {
      id: "pages",
      key: KNOWLEDGE_KEYS.pages,
      label: "Store pages",
      kind: "reference",
      header: `# Store pages — ${storeName} (${shop})${SEP}`,
      items: snapshot.pages.map((p) => renderPage(p, shop)).filter((x): x is string => Boolean(x)),
      noun: "pages",
      fetched: snapshot.pages.length,
      renderable: snapshot.pages.length,
    },
  ];

  const fullLen = (s: Section) => (s.items.length ? s.header.length + s.items.reduce((n, i) => n + i.length, 0) + SEP.length * (s.items.length - 1) : 0);
  const preferred = (s: Section) => Math.min(limits.perSourceChars, Math.floor(limits.totalChars * PREFERRED_SHARE[s.id]));

  const sources: KnowledgeSource[] = [];
  const counts: KnowledgeCounts = { products: 0, policies: 0, pages: 0 };
  const fetched: KnowledgeCounts = { products: 0, policies: 0, pages: 0 };
  let remaining = limits.totalChars;
  let truncated = false;

  // #2132 FAIL B — the order-help how-to is ALWAYS published first (a few hundred
  // chars, reserved before the store sections share the rest of the budget).
  const orderHelp = renderOrderHelp(shop, storeName, snapshot.policies);
  if (orderHelp.length <= Math.min(limits.perSourceChars, remaining) && sources.length < limits.maxSources) {
    sources.push({ key: KNOWLEDGE_KEYS.orderHelp, label: "Order help in this chat", kind: "howto", content: orderHelp });
    remaining -= orderHelp.length;
  }

  sections.forEach((section, i) => {
    fetched[section.id] = section.fetched;
    const reserveLater = sections.slice(i + 1).reduce((n, s) => n + Math.min(fullLen(s), preferred(s)), 0);
    const cap = Math.max(0, Math.min(limits.perSourceChars, remaining - reserveLater, fullLen(section)));
    const { content, included } = pack(section, cap);
    counts[section.id] = included;
    // Truncation = whole ITEMS that did not fit (or unrenderable rows), never the
    // deliberate exclusion of drafts/archived products (counted in `fetched` only).
    if (included < section.items.length || section.items.length < section.renderable) truncated = true;
    if (!content || sources.length >= limits.maxSources) return;
    sources.push({ key: section.key, label: section.label, kind: section.kind, content });
    remaining -= content.length;
  });

  const totalChars = sources.reduce((n, s) => n + s.content.length, 0);
  return { sources, counts, fetched, totalChars, truncated };
}
