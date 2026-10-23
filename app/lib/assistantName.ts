/**
 * What a store's assistant is CALLED — one rule for the merchant's Settings form,
 * the provisioning default and what shoppers see in the chat.
 *
 * Busymate AI's platform naming (busymate-ai-src docs/architecture/bmai.md, naming):
 * "your mate" is the public name of the PLATFORM's own assistant (busymate.ai).
 * A white-label store is NOT the platform, so the platform renders a store whose
 * assistant name is unset — or still the platform's persona phrase "your mate"
 * (or its retired spellings "mate" / "bro") — as "<Store display name> AI"
 * (`supportAssistantDisplayName`, busymate-devtools#3929). This module mirrors
 * that rule so the merchant sees exactly the name the shopper sees
 * (busymate-ai-src#2618 follow-up: Settings showed "your mate" while the
 * storefront greeted shoppers as "Tony Stark AI").
 */

/** The platform persona spellings the platform treats as "unset" on a store. */
const PLATFORM_PERSONA_NAMES = new Set(["your mate", "mate", "bro"]);

/** True when `name` is the platform's own persona phrase (never a store's name). */
export function isPlatformPersonaName(name: string | null | undefined): boolean {
  return PLATFORM_PERSONA_NAMES.has((name ?? "").trim().toLowerCase());
}

/** "<Store> AI" — a store name that already ends in "AI" is used as-is (no "AI AI"). */
export function brandedAssistantName(productName: string): string {
  const name = productName.trim() || "Store";
  return /\bai$/i.test(name) ? name : `${name} AI`;
}

/** The name shoppers actually see for (assistantName, productName). */
export function effectiveAssistantName(assistantName: string | null | undefined, productName: string): string {
  const configured = (assistantName ?? "").trim();
  return configured && !isPlatformPersonaName(configured) ? configured : brandedAssistantName(productName);
}

/** A store's display name from its myshopify domain (fallback when the shop name is unknown). */
export function displayNameFromShop(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, "");
}
