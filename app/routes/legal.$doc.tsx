import type { LoaderFunctionArgs } from "react-router";
import { renderAllLegal } from "../../scripts/lib/render-legal.mjs";

/**
 * The listing's legal pages, served by the APP from docs/legal/*.md
 * (busymate-ai-src#2624 / independent review 4.3): they used to be static HTML baked
 * into the edge image on 2026-09-02, so a docs fix never reached the public FAQ
 * (it still said the assistant is called "bro" and gave a personal mailbox).
 * Now every deploy of the app ships its own legal pages.
 *
 *   /legal/shopify-privacy · /legal/shopify-faq · /legal/shopify-terms
 * (the edge 301s /legal/{privacy,faq,terms} here).
 */
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

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const html = legalPage(params.doc ?? "");
  if (!html) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
};
