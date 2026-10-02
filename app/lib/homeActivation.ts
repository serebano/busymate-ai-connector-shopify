/**
 * Home's activation state — the ONE derivation of "is the embed CTA offered" and
 * "does Home keep re-checking by itself" (Shopify review 5.1.2, audit 2026-10-02).
 *
 * The 2026-09-24 reviewer screencast 2 (fresh install): Home rendered ~5 s after
 * the install, while `afterAuth` was still publishing the tenant. Its row still
 * read `provisionState: "pending"`, so `published` was false, which meant
 *   • `embedCtaReady(null, null)` → true — "Turn on the storefront assistant" was
 *     ENABLED on a tenant that did not exist yet, and
 *   • `activating` was false — Home never re-checked, so it sat on
 *     "0/4 done · Provisioning" until a manual reload.
 * The reviewer clicked, saved the embed, opened the chat: "refused to connect".
 * Reproduced live on 2026-10-02 (busymate-ai-review-test-6, app 0.1.13).
 *
 * Rule: a tenant that is not published yet is ACTIVATING — the CTA is held and
 * Home re-checks (5 s × 5 min, then 30 s with Retry setup) until the tenant is
 * published AND the platform says the chat can be framed. A provisioning ERROR
 * holds the CTA too, but is not "activating": Home shows "Provisioning needs
 * attention" with Retry setup instead of a spinner that never ends.
 */
import { embedCtaReady, type Frameable, type RuntimeStateForCta } from "./embedFrameable";

export interface HomeActivationInput {
  /** `ShopTenant.provisionState` ("pending" | "published" | "error" | "suspended" | …). */
  readonly provisionState: string;
  /** `provisionState === "published"` AND the platform tenant id is known. */
  readonly published: boolean;
  /** The runtime-readiness read (null when not published / not asked). */
  readonly runtime: RuntimeStateForCta;
  /** The platform's frameability answer (null when not published / not asked). */
  readonly frameable: Frameable;
}

export interface HomeActivation {
  /** "Turn on the storefront assistant" + "Open App embeds" are offered. */
  readonly embedReady: boolean;
  /** Home re-checks by itself and shows the "being activated" banner. */
  readonly activating: boolean;
}

export function homeActivation(input: HomeActivationInput): HomeActivation {
  if (input.provisionState === "error") return { embedReady: false, activating: false };
  if (!input.published) return { embedReady: false, activating: true };
  const embedReady = embedCtaReady(input.runtime, input.frameable);
  return { embedReady, activating: !embedReady && input.runtime !== "error" };
}
