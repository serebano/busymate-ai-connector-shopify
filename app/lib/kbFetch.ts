/**
 * Store snapshot fetch (Admin GraphQL 2026-07) → `knowledge_sources` build.
 *
 * Reads, through the shop's (refreshing) offline session:
 *   - products      (read_products)  — title, handle, price, description, URL
 *   - shop policies (read_legal_policies) — type, title, body, URL
 *   - pages         (read_content)    — title, handle, body
 *
 * No Prisma, no MCP: the seam modules (bmai.server, ingest) compose this with
 * the publish + persistence. Any Admin failure THROWS with Shopify's message so
 * the caller persists + surfaces it (never a silent empty assistant).
 */
import { adminForShop } from "../mcp/shopifyAdmin";
import { buildKnowledgeSources, type KbPage, type KbPolicy, type KbProduct, type KbSnapshot, type KnowledgeBuild } from "./kbSnapshot";

export const KB_INGEST_QUERY = `#graphql
  query KbIngest {
    shop {
      name
      shopPolicies { type title body url }
    }
    products(first: 250) {
      nodes {
        title handle status descriptionHtml onlineStoreUrl productType vendor
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        compareAtPriceRange { minVariantCompareAtPrice { amount currencyCode } }
      }
    }
    pages(first: 100) { nodes { title handle body } }
  }`;

interface KbIngestData {
  shop?: { name?: string | null; shopPolicies?: KbPolicy[] | null } | null;
  products?: { nodes?: KbProduct[] | null } | null;
  pages?: { nodes?: KbPage[] | null } | null;
}

/** Fetch the store's products, policies and pages as ONE snapshot. */
export async function buildKbSnapshot(shop: string): Promise<KbSnapshot> {
  const admin = await adminForShop(shop);
  const data = ((await admin.graphql(KB_INGEST_QUERY)) ?? {}) as KbIngestData;
  return {
    shop,
    shopName: data.shop?.name ?? null,
    products: data.products?.nodes ?? [],
    policies: data.shop?.shopPolicies ?? [],
    pages: data.pages?.nodes ?? [],
    generatedAt: new Date().toISOString(),
  };
}

/** Snapshot → compressed knowledge within the platform limits. */
export async function buildKnowledgeForShop(shop: string): Promise<KnowledgeBuild> {
  return buildKnowledgeSources(await buildKbSnapshot(shop));
}
