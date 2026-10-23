import type { LoaderFunctionArgs } from "react-router";
import { legalPage } from "../lib/legalPages.server";

/**
 * The listing's legal pages, served by the APP from docs/legal/*.md
 * (busymate-ai-src#2624 / independent review 4.3): they used to be static HTML baked
 * into the edge image on 2026-09-02, so a docs fix never reached the public FAQ.
 *   /legal/shopify-privacy · /legal/shopify-faq · /legal/shopify-terms
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const html = legalPage(params.doc ?? "");
  if (!html) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
};
