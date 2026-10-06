/**
 * Home's activation state — the ONE derivation of "is the embed CTA offered",
 * "is the assistant being activated (hold + banner)" and "does Home keep
 * re-checking by itself" (Shopify review 5.1.2, audit 2026-10-02).
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
 *
 * 0.1.15 (reinstall, busymate-ai-review-test-7, app 0.1.14): right after a
 * reinstall the platform answered `frameable: true` BEFORE the runtime-readiness
 * read said `ready`, so the CTA was (rightly) offered while the "Assistant
 * provisioned" step still read "To do — waiting to become active". `activating`
 * was false (the CTA is not held), and the re-check was tied to `activating`, so
 * the stale badge stayed until a manual reload ("1/4 done · Activating" → on
 * reload "2/4 · Live"). The RE-CHECK condition is therefore separate from the
 * HOLD condition: Home keeps re-checking whenever the runtime is not yet `ready`
 * (pending / orphaned / unverified / null while published, or not published at
 * all) — even while the CTA is offered — and the "being activated" banner stays
 * tied to the hold only. A runtime `error` is the one settled non-ready state:
 * it is never re-polled (Retry setup re-runs the lifecycle).
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
  /** The CTA is HELD while the assistant is being activated: the "being activated" banner shows. */
  readonly activating: boolean;
  /** Home re-runs its loader by itself (5 s × 5 min, then 30 s) until the runtime is `ready`. */
  readonly recheck: boolean;
}

/** The runtime states that are settled: nothing a re-check could change. */
function runtimeSettled(runtime: RuntimeStateForCta): boolean {
  return runtime === "ready" || runtime === "error";
}

export function homeActivation(input: HomeActivationInput): HomeActivation {
  if (input.provisionState === "error") return { embedReady: false, activating: false, recheck: false };
  if (!input.published) return { embedReady: false, activating: true, recheck: true };
  const embedReady = embedCtaReady(input.runtime, input.frameable);
  const activating = !embedReady && input.runtime !== "error";
  // Re-check while held (whatever the runtime says) AND while the runtime has not
  // settled — the CTA may already be offered on the platform's frameable:true
  // while the readiness read still says pending (the 0.1.15 reinstall case).
  const recheck = activating || !runtimeSettled(input.runtime);
  return { embedReady, activating, recheck };
}
