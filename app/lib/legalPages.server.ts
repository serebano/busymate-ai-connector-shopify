import { renderAllLegal } from "../../scripts/lib/render-legal.mjs";

/** /legal/shopify-{privacy,faq,terms} → rendered HTML from docs/legal (busymate-ai-src#2624). */
const DOCS: Record<string, string> = {
  "shopify-privacy": "privacy.html",
  "shopify-faq": "faq.html",
  "shopify-terms": "terms.html",
};

let cache: Map<string, string> | null = null;

export function legalPage(doc: string, root: string = process.cwd()): string | null {
  const out = DOCS[doc];
  if (!out) return null;
  if (!cache) cache = new Map(renderAllLegal(root).map((p: { out: string; html: string }) => [p.out, p.html]));
  return cache.get(out) ?? null;
}
