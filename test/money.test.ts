import { beforeEach, describe, expect, it } from "vitest";
import { clearMoneyFormatCache, formatMoney, loadMoneyFormat } from "../app/lib/money";
import { getProduct, searchProducts } from "../app/mcp/tools/products";
import { buildKnowledgeSources } from "../app/lib/kbSnapshot";
import type { ToolContext } from "../app/mcp/tools/types";

const PHP = { moneyFormat: "₱{{amount}}", currencyCode: "PHP" };

describe("formatMoney (shop money format)", () => {
  it("writes the peso sign for a PHP shop", () => {
    expect(formatMoney({ amount: "3299.0", currencyCode: "PHP" }, PHP)).toBe("₱3,299.00");
    expect(formatMoney({ amount: "599.5", currencyCode: "PHP" }, PHP)).toBe("₱599.50");
  });
  it("supports the other Liquid tokens", () => {
    const f = (moneyFormat: string, amount = "1234567.5") => formatMoney({ amount, currencyCode: "EUR" }, { moneyFormat, currencyCode: "EUR" });
    expect(f("{{amount_with_comma_separator}} €")).toBe("1.234.567,50 €");
    expect(f("${{amount_no_decimals}}")).toBe("$1,234,568");
    expect(f("CHF {{amount_with_apostrophe_separator}}")).toBe("CHF 1'234'567.50");
    expect(f("{{amount_no_decimals_with_space_separator}} kr")).toBe("1 234 568 kr");
  });
  it("decodes HTML entities and strips tags in the format", () => {
    expect(formatMoney({ amount: "10", currencyCode: "EUR" }, { moneyFormat: "<span class=money>&euro;{{amount}}</span>", currencyCode: "EUR" })).toBe("€10.00");
    expect(formatMoney({ amount: "10", currencyCode: "JPY" }, { moneyFormat: "&#165;{{amount_no_decimals}}", currencyCode: "JPY" })).toBe("¥10");
  });
  it("falls back to '<amount> <CODE>' with no format, another currency or an unknown token", () => {
    expect(formatMoney({ amount: "3299.0", currencyCode: "PHP" })).toBe("3299.0 PHP");
    expect(formatMoney({ amount: "5.00", currencyCode: "USD" }, PHP)).toBe("5.00 USD");
    expect(formatMoney({ amount: "5.00", currencyCode: "PHP" }, { moneyFormat: "{{weird}}", currencyCode: "PHP" })).toBe("5.00 PHP");
    expect(formatMoney(null, PHP)).toBeNull();
  });
});

function adminWith(moneyFormat: string | null, shop = "ph.myshopify.com") {
  const calls: string[] = [];
  const admin = {
    shop,
    graphql: async (query: string) => {
      calls.push(query);
      if (query.includes("ShopMoneyFormat")) {
        if (moneyFormat === null) throw new Error("boom");
        return { shop: { currencyCode: "PHP", currencyFormats: { moneyFormat } } };
      }
      if (query.includes("SearchProducts"))
        return {
          products: { nodes: [{ id: "1", title: "Denim Jacket", handle: "denim-jacket", status: "ACTIVE", onlineStoreUrl: "https://x/products/denim-jacket", publishedAt: "2026-01-01", totalInventory: 3,
            priceRangeV2: { minVariantPrice: { amount: "3299.0", currencyCode: "PHP" } },
            compareAtPriceRange: { minVariantCompareAtPrice: { amount: "3999.0", currencyCode: "PHP" } } }] },
        };
      return {
        productByHandle: { id: "1", title: "Denim Jacket", handle: "denim-jacket", status: "ACTIVE", descriptionHtml: "", onlineStoreUrl: "https://x/products/denim-jacket", publishedAt: "2026-01-01",
          priceRangeV2: { minVariantPrice: { amount: "3299.0", currencyCode: "PHP" } },
          variants: { nodes: [{ id: "v", title: "M", price: "3299.0", compareAtPrice: "3999.0", availableForSale: true }] } },
      };
    },
  };
  return { admin, calls, ctx: { shop, customerId: null, confirmed: false, admin } as unknown as ToolContext };
}

describe("tools use the shop money format", () => {
  beforeEach(() => clearMoneyFormatCache());

  it("search_products says ₱3,299.00, not 3299.0 PHP", async () => {
    const { ctx } = adminWith("₱{{amount}}");
    const r = await searchProducts({ query: "jacket" }, ctx);
    expect(r.content[0]!.text).toContain("Denim Jacket — ₱3,299.00 (on sale, was ₱3,999.00)");
    expect(r.content[0]!.text).not.toContain("PHP");
    expect((r.structuredContent as { products: Array<{ price: string; currency: string }> }).products[0]).toMatchObject({ price: "₱3,299.00", currency: "PHP" });
  });

  it("get_product formats priceFrom and variant prices", async () => {
    const { ctx } = adminWith("₱{{amount}}");
    const r = await getProduct({ handle: "denim-jacket" }, ctx);
    expect(r.content[0]!.text).toContain("from ₱3,299.00");
    expect(r.content[0]!.text).toContain("on sale: ₱3,299.00, was ₱3,999.00");
  });

  it("keeps the old text when the format cannot be read, and caches per shop", async () => {
    const bad = adminWith(null);
    const r = await searchProducts({ query: "jacket" }, bad.ctx);
    expect(r.content[0]!.text).toContain("3299.0 PHP");
    const ok = adminWith("₱{{amount}}", "cache.myshopify.com");
    await loadMoneyFormat(ok.admin);
    await loadMoneyFormat(ok.admin);
    expect(ok.calls.filter((q) => q.includes("ShopMoneyFormat"))).toHaveLength(1);
  });

  it("knowledge snapshot writes prices in the shop format", () => {
    const built = buildKnowledgeSources({
      shop: "ph.myshopify.com",
      shopName: "Nano",
      moneyFormat: PHP,
      policies: [],
      pages: [],
      generatedAt: "2026-11-26T00:00:00Z",
      products: [{ title: "Denim Jacket", handle: "denim-jacket", status: "ACTIVE", onlineStoreUrl: "https://x/products/denim-jacket", publishedAt: "2026-01-01", priceRangeV2: { minVariantPrice: { amount: "3299.0", currencyCode: "PHP" }, maxVariantPrice: { amount: "3299.0", currencyCode: "PHP" } } }],
    });
    const text = JSON.stringify(built);
    expect(text).toContain("Price: ₱3,299.00");
    expect(text).not.toContain("3299.0 PHP");
  });
});
