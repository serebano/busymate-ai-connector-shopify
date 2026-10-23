/**
 * Plain-language errors for the embedded admin (App Store Req 2.1.1).
 *
 * Shopify's reviewer saw `set_tenant_branding refused: native_action_denied (denied) — …`
 * in a toast (busymate-ai-src#2618). A merchant must never read a tool name, a refusal
 * code or a stack fragment: the raw cause goes to the server log, the merchant gets one
 * sentence that says what did not happen and what to do next.
 *
 * A message that is already merchant-facing (our own validation copy such as
 * "Both names are required.") passes through unchanged.
 */
export type MerchantAction = "branding" | "retrain" | "reprovision" | "billing";

export const SUPPORT_EMAIL = "hi@busymate.ai";

const FRIENDLY: Record<MerchantAction, string> = {
  branding: `We couldn't save your assistant settings. Nothing was changed. Please try again in a minute; if it keeps happening, email ${SUPPORT_EMAIL} and we'll fix it.`,
  retrain: `Training didn't finish, so your assistant still uses its previous knowledge. Please try Re-train again in a minute; if it keeps happening, email ${SUPPORT_EMAIL}.`,
  reprovision: `Your store connection isn't live yet. Please try again in a minute; if it keeps happening, email ${SUPPORT_EMAIL}.`,
  billing: `We couldn't confirm your plan with Shopify right now. Your plan is unchanged. Please refresh again in a minute.`,
};

// Anything that reads like machinery: snake_case identifiers (tool names, refusal codes),
// protocol words, transport failures, HTTP statuses, JS error class names.
const TECHNICAL = [
  /\b[a-z0-9]+_[a-z0-9_]+\b/,
  /\b(refused|denied|mcp|rpc|json|jsonrpc|bridge|tenant|proof|preflight|graphql|prisma|undefined|null)\b/i,
  /\b(fetch failed|ECONN\w*|ETIMEDOUT|timed? ?out|aborted|socket|network)\b/i,
  /\bHTTP\s?\d{3}\b|\b[45]\d\d\b/,
  /\b\w*Error\b|\bat \S+:\d+/,
];

export function isTechnical(raw: string): boolean {
  return TECHNICAL.some((re) => re.test(raw));
}

/** The merchant-facing sentence for a failed admin action (the raw cause is never shown). */
export function merchantMessage(action: MerchantAction, raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text || isTechnical(text)) return FRIENDLY[action];
  return text;
}

/** Log the raw cause server-side (ops can still see it), return the merchant sentence. */
export function merchantError(action: MerchantAction, shop: string, raw: string | null | undefined): string {
  const message = merchantMessage(action, raw);
  if (message !== (raw ?? "").trim()) console.warn(`[admin] ${action} failed for ${shop}: ${raw ?? "unknown"}`);
  return message;
}
