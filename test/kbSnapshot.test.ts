import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_KEYS,
  KNOWLEDGE_LIMITS,
  buildKnowledgeSources,
  htmlToText,
  type KbSnapshot,
} from "../app/lib/kbSnapshot";

/**
 * The store → `knowledge_sources` compressor (#2110 grounding). The platform
 * contract (publish_tenant_runtime.knowledge_sources): ≤40 sources, key
 * ^[a-z0-9][a-z0-9:._-]{0,119}$, kind fact|howto|reference|glossary, content
 * 1..20,000 chars per source and ≤40,000 chars TOTAL per call. Anything over is
 * refused at the edge, so the builder must be deterministic and never exceed
 * the limits — most-important content first (policies → products → pages).
 */
const KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,119}$/;

function snapshot(partial: Partial<KbSnapshot> = {}): KbSnapshot {
  return {
    shop: "acme.myshopify.com",
    shopName: "Acme",
    products: [],
    policies: [],
    pages: [],
    generatedAt: "2026-09-02T10:00:00.000Z",
    ...partial,
  };
}

function product(i: number, descLen = 120, published = true) {
  return {
    title: `Product ${i}`,
    handle: `product-${i}`,
    descriptionHtml: `<p>${"Great item. ".repeat(Math.ceil(descLen / 12)).slice(0, descLen)}</p>`,
    onlineStoreUrl: published ? `https://acme.myshopify.com/products/product-${i}` : null,
    status: published ? "ACTIVE" : "DRAFT",
    priceRangeV2: { minVariantPrice: { amount: `${10 + i}.00`, currencyCode: "USD" } },
  };
}

describe("htmlToText", () => {
  it("strips tags, decodes entities and collapses whitespace", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b> &amp; friends</p>\n<ul><li>one</li><li>two</li></ul>")).toBe(
      "Hello world & friends\none\ntwo",
    );
    expect(htmlToText("<div>a</div><div>b</div>")).toBe("a\nb");
    expect(htmlToText("&#39;quoted&#39; &lt;tag&gt; &#x27;x&#x27;")).toBe("'quoted' <tag> 'x'");
  });
  it("drops script/style bodies and returns '' for empty input", () => {
    expect(htmlToText("<style>p{}</style><script>alert(1)</script><p>ok</p>")).toBe("ok");
    expect(htmlToText(null)).toBe("");
    expect(htmlToText("   \n ")).toBe("");
  });
});

describe("buildKnowledgeSources — shape", () => {
  it("renders products (title, handle, price, URL, short plain-text description)", () => {
    const out = buildKnowledgeSources(snapshot({ products: [product(1)] }));
    const products = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.products)!;
    expect(products).toBeDefined();
    expect(products.kind).toBe("fact");
    expect(products.label).toMatch(/product/i);
    expect(products.content).toContain("Product 1");
    expect(products.content).toContain("product-1");
    expect(products.content).toContain("11.00 USD");
    expect(products.content).toContain("https://acme.myshopify.com/products/product-1");
    expect(products.content).toContain("Great item.");
    expect(products.content).not.toContain("<p>");
    expect(out.counts).toEqual({ products: 1, policies: 0, pages: 0 });
  });

  it("renders policies (type/title/body as text) and pages (title + body as text + URL)", () => {
    const out = buildKnowledgeSources(
      snapshot({
        policies: [{ type: "REFUND_POLICY", title: "Refund policy", body: "<p>30 days.</p>", url: "https://acme.myshopify.com/policies/refund-policy" }],
        pages: [{ title: "About us", handle: "about-us", body: "<h1>We</h1><p>make things</p>" }],
      }),
    );
    const policies = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.policies)!;
    const pages = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.pages)!;
    expect(policies.content).toContain("Refund policy");
    expect(policies.content).toContain("30 days.");
    expect(policies.content).toContain("https://acme.myshopify.com/policies/refund-policy");
    expect(policies.kind).toBe("reference");
    expect(pages.content).toContain("About us");
    expect(pages.content).toContain("make things");
    expect(pages.content).toContain("https://acme.myshopify.com/pages/about-us");
    expect(out.counts).toEqual({ products: 0, policies: 1, pages: 1 });
  });

  it("every key matches the platform regex, kinds are valid, and an empty store yields no sources", () => {
    const out = buildKnowledgeSources(snapshot({ products: [product(1)], policies: [{ title: "P", body: "x" }], pages: [{ title: "Q", body: "y" }] }));
    expect(out.sources.length).toBe(4);
    for (const s of out.sources) {
      expect(s.key).toMatch(KEY_RE);
      expect(["fact", "howto", "reference", "glossary"]).toContain(s.kind);
      expect(s.content.length).toBeGreaterThan(0);
    }
    // Policies come FIRST (most important), then products, then pages.
    expect(out.sources.map((s) => s.key)).toEqual([KNOWLEDGE_KEYS.orderHelp, KNOWLEDGE_KEYS.policies, KNOWLEDGE_KEYS.products, KNOWLEDGE_KEYS.pages]);
    // An empty store still publishes the order-help how-to (#2132 FAIL B) and nothing else.
    const empty = buildKnowledgeSources(snapshot());
    expect(empty.sources.map((s) => s.key)).toEqual([KNOWLEDGE_KEYS.orderHelp]);
    expect(empty.counts).toEqual({ products: 0, policies: 0, pages: 0 });
    expect(empty.totalChars).toBe(empty.sources[0].content.length);
  });

  it("keeps Online Store products in API order and leaves every other product out", () => {
    const unpublished = { ...product(1, 40, true), onlineStoreUrl: null, status: "ACTIVE", publishedAt: null };
    const out = buildKnowledgeSources(snapshot({ products: [unpublished, product(2, 40, true), product(3, 40, true)] }));
    const c = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.products)!.content;
    expect(c.indexOf("Product 2")).toBeLessThan(c.indexOf("Product 3"));
    expect(c).not.toContain("Product 1");
  });
});

describe("buildKnowledgeSources — limits (deterministic, most-important first)", () => {
  it("never exceeds 20,000 chars per source or 40,000 total; whole products only, with a '+N more' note", () => {
    const products = Array.from({ length: 250 }, (_, i) => product(i + 1, 400));
    const out = buildKnowledgeSources(snapshot({ products }));
    const src = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.products)!;
    expect(src.content.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.perSourceChars);
    expect(out.totalChars).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.totalChars);
    expect(out.truncated).toBe(true);
    expect(out.counts.products).toBeLessThan(250);
    expect(out.counts.products).toBeGreaterThan(20);
    expect(out.fetched.products).toBe(250);
    expect(src.content).toMatch(new RegExp(`\\+${250 - out.counts.products} more products`));
    // No half product: the last included product's URL line is intact.
    expect(src.content).toContain(`https://acme.myshopify.com/products/product-${out.counts.products}`);
    expect(src.content).not.toContain(`Product ${out.counts.products + 1}\n`);
  });

  it("is deterministic — the same snapshot always compresses to the same bytes", () => {
    const products = Array.from({ length: 120 }, (_, i) => product(i + 1, 300));
    const a = buildKnowledgeSources(snapshot({ products }));
    const b = buildKnowledgeSources(snapshot({ products }));
    expect(a).toEqual(b);
  });

  it("policies are never starved by a huge catalog, and the total stays ≤40,000", () => {
    const products = Array.from({ length: 250 }, (_, i) => product(i + 1, 500));
    const policies = [
      { type: "REFUND_POLICY", title: "Refund policy", body: "<p>" + "Refund text. ".repeat(500) + "</p>" },
      { type: "SHIPPING_POLICY", title: "Shipping policy", body: "<p>" + "Ship text. ".repeat(400) + "</p>" },
    ];
    const pages = Array.from({ length: 50 }, (_, i) => ({ title: `Page ${i}`, handle: `page-${i}`, body: "<p>" + "Page text. ".repeat(300) + "</p>" }));
    const out = buildKnowledgeSources(snapshot({ products, policies, pages }));
    const total = out.sources.reduce((n, s) => n + s.content.length, 0);
    expect(total).toBe(out.totalChars);
    expect(total).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.totalChars);
    for (const s of out.sources) expect(s.content.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.perSourceChars);
    const pol = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.policies)!;
    // Both policies (≈11,000 chars of text) fit whole — policies win the budget.
    expect(out.counts.policies).toBe(2);
    expect(pol.content).toContain("Shipping policy");
    // Products still get the lion's share and pages get what is left.
    const prod = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.products)!;
    const pg = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.pages)!;
    expect(prod.content.length).toBeGreaterThan(pg.content.length);
    expect(out.counts.pages).toBeGreaterThan(0);
    expect(out.truncated).toBe(true);
  });

  it("a single oversized policy is cut with an ellipsis instead of dropped", () => {
    const policies = [{ type: "TERMS_OF_SERVICE", title: "Terms", body: "<p>" + "Term. ".repeat(10_000) + "</p>" }];
    const out = buildKnowledgeSources(snapshot({ policies }));
    const pol = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.policies)!;
    expect(pol.content.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.perSourceChars);
    expect(pol.content).toContain("Terms");
    expect(pol.content).toMatch(/…/);
    expect(out.counts.policies).toBe(1);
  });

  it("honours custom (smaller) limits the same way", () => {
    const products = Array.from({ length: 30 }, (_, i) => product(i + 1, 100));
    const out = buildKnowledgeSources(snapshot({ products }), { perSourceChars: 1_500, totalChars: 3_000, maxSources: 40 });
    expect(out.totalChars).toBeLessThanOrEqual(3_000);
    expect(out.sources[0].content.length).toBeLessThanOrEqual(1_500);
    expect(out.counts.products).toBeGreaterThan(0);
    expect(out.counts.products).toBeLessThan(30);
  });
});

// #2110 (seen live on the demo store): the assistant listed "The Draft Snowboard —
// Not published on the online store" and "The Archived Snowboard" to a shopper.
// Drafts and archived products are merchant-internal — never knowledge.
describe("buildKnowledgeSources — only sellable products are knowledge", () => {
  const base = { descriptionHtml: "<p>Board</p>", priceRangeV2: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } } };
  it("excludes DRAFT, ARCHIVED and every product that is not on the Online Store, but counts them as fetched", () => {
    const out = buildKnowledgeSources(
      snapshot({
        products: [
          { ...base, title: "Live board", handle: "live", status: "ACTIVE", onlineStoreUrl: "https://s.myshopify.com/products/live" },
          // A password-protected store: onlineStoreUrl is null on every product, publishedAt tells them apart.
          { ...base, title: "Password-store board", handle: "pw", status: "ACTIVE", onlineStoreUrl: null, publishedAt: "2026-10-01T00:00:00Z" },
          { ...base, title: "Draft board", handle: "draft", status: "DRAFT", onlineStoreUrl: null },
          { ...base, title: "Archived board", handle: "archived", status: "ARCHIVED", onlineStoreUrl: null },
          { ...base, title: "POS-only board", handle: "pos", status: "ACTIVE", onlineStoreUrl: null, publishedAt: null },
          // src#2624 review X2 — in every generated test store: ACTIVE, published nowhere.
          { ...base, title: "The Hidden Snowboard", handle: "the-hidden-snowboard", status: "ACTIVE", onlineStoreUrl: null, publishedAt: null },
          { ...base, title: "Unknown-status board", handle: "unknown", status: null, onlineStoreUrl: "https://s.myshopify.com/products/unknown" },
        ],
      }),
    );
    const c = out.sources.find((s) => s.key === KNOWLEDGE_KEYS.products)!.content;
    expect(c).toContain("Live board");
    expect(c).toContain("Password-store board");
    expect(c).toContain("URL: https://acme.myshopify.com/products/pw");
    expect(c).toContain("Unknown-status board");
    for (const hidden of ["Draft board", "Archived board", "POS-only board", "The Hidden Snowboard", "the-hidden-snowboard", "not published"]) expect(c).not.toContain(hidden);
    expect(out.counts.products).toBe(3);
    expect(out.fetched.products).toBe(7);
    // Excluding products a shopper cannot open is not a size truncation.
    expect(out.truncated).toBe(false);
  });
});

// ── #2132 FAIL B: the "order help in this chat" how-to ───────────────────────
// A guest asking "Where is my order?" must be told to SIGN IN (the visible Sign in
// control) and offered a human — grounded in the store's own published knowledge,
// so the answer never falls back to a generic "e-mail us" deflection.
describe("buildKnowledgeSources — order help how-to (#2132)", () => {
  it("is published FIRST, as a howto, naming the Sign in control, the account login URL, and the human option", () => {
    const out = buildKnowledgeSources(snapshot({ shop: "acme.myshopify.com", shopName: "Acme" }));
    const help = out.sources[0];
    expect(help.key).toBe(KNOWLEDGE_KEYS.orderHelp);
    expect(help.key).toMatch(KEY_RE);
    expect(help.kind).toBe("howto");
    expect(help.content).toContain('"Sign in" button at the top of this chat');
    expect(help.content).toContain("https://acme.myshopify.com/account/login");
    expect(help.content).toMatch(/talk to a human/);
    // The sign-in ask and the human offer live in ONE sentence, so a summary keeps both.
    expect(help.content).toMatch(/two options: sign in with the "Sign in" button[^\n]*or ask to talk to a human/);
    expect(help.content).toContain("signed-in customers only");
    expect(help.content.length).toBeLessThan(1_500);
  });

  it("survives a huge catalog (reserved before the store sections) and the total stays within the platform limit", () => {
    const out = buildKnowledgeSources(snapshot({ products: Array.from({ length: 400 }, (_, i) => product(i + 1, 900)) }));
    expect(out.sources[0].key).toBe(KNOWLEDGE_KEYS.orderHelp);
    expect(out.totalChars).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.totalChars);
    expect(out.sources.every((s) => s.content.length <= KNOWLEDGE_LIMITS.perSourceChars)).toBe(true);
  });
});
