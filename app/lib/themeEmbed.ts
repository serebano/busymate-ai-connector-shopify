/**
 * Theme app-embed onboarding (App Store Req 5.1.3) — the ONE thing a merchant
 * must do after install: enable the "Busymate AI assistant" app embed in
 * Theme editor → App embeds. This module owns the deep link + the setup
 * checklist Home renders, and a scope-free embed detector.
 *
 * Activation uses SHOPIFY_API_KEY (the app client_id), not a CDN asset UUID.
 * Shopify deprecated extension UUID activation links. Detection matches the
 * extension asset + this store's slug, never a CDN UUID (#3718).
 * https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
 *
 * LEAST PRIVILEGE: no `read_themes` scope. Embed status is detected from the
 * PUBLIC storefront HTML (does it load the extension asset?). A password-
 * protected dev store or any non-200 is "unknown" — never a false "off".
 */
import { formatServerTime } from "./formatTime";
import { shopToSlug } from "./tenantSlug";

/**
 * The storefront-assistant extension's CDN UUID as of 2026-09-24 (the live
 * `busymate-ai-5` version). Informational only — embed detection matches the
 * asset + this store's slug (see `detectStorefrontEmbed`), never this value.
 */
export const STOREFRONT_ASSISTANT_EXTENSION_UUID = "01a061be-71c0-7659-afb4-b5e0d5ef3c3e";
/** blocks/assistant.liquid → the block handle in `activateAppId=<uuid>/<block>`. */
export const STOREFRONT_ASSISTANT_BLOCK = "assistant";
/** The app embed's name as listed in Theme editor → App embeds (schema `name`). */
export const APP_EMBED_LABEL = "Busymate AI assistant";

/** Theme editor with the app embed pre-activated (merchant still clicks Save). */
export function themeEditorActivateUrl(shop: string, opts: { apiKey?: string; block?: string } = {}): string {
  const apiKey = (opts.apiKey ?? process.env.SHOPIFY_API_KEY ?? "").trim();
  // Without app identity, open the manual app-embeds panel instead of a dead link.
  if (!apiKey) return themeEditorAppEmbedsUrl(shop);
  const block = opts.block ?? STOREFRONT_ASSISTANT_BLOCK;
  return `${themeEditorAppEmbedsUrl(shop)}&activateAppId=${encodeURIComponent(apiKey)}/${encodeURIComponent(block)}`;
}

/** Theme editor → App embeds panel (fallback when the deep link is stale). */
export function themeEditorAppEmbedsUrl(shop: string): string {
  return `https://${shop}/admin/themes/current/editor?context=apps`;
}

export type EmbedStatus = "on" | "off" | "unknown";

/** Home instructions must reflect what the scope-free storefront check knows. */
export function embedSetupPresentation(status: EmbedStatus) {
  if (status === "on") {
    return {
      heading: "Storefront assistant is on",
      detail: "The assistant is loading on your storefront. Open App embeds to review it; click Save if you make a change.",
      button: "Review in App embeds",
      activationLink: false,
    };
  }
  if (status === "off") {
    return {
      heading: "Turn on the storefront assistant",
      detail: "The storefront check did not find the assistant. Open the theme editor, switch on the app embed, and click Save.",
      button: "Turn on the storefront assistant",
      activationLink: true,
    };
  }
  return {
    heading: "Check storefront assistant status",
    detail: "We can't confirm the embed from this storefront. It may be password-protected or unavailable. Open App embeds to check its state; save only if you change it. Home will show the status as unconfirmed until the storefront can be checked.",
    button: "Check in App embeds",
    activationLink: false,
  };
}

/**
 * Read the storefront home page and look for OUR app embed's script tag: the
 * extension asset `…/assets/assistant.js` carrying THIS store's `data-slug`.
 * Uses no Admin scope. `unknown` when the store is password-protected, errors,
 * or is not 200 — the UI then shows the written steps instead of a false "off".
 *
 * #3718 (Shopify review 5.1.2, 2026-09-24): this used to match a hard-coded
 * extension CDN UUID (`01a04ae4…`), but the live extension serves from
 * `01a061be-…`, so Home said "Not on yet" on a storefront where the embed WAS
 * on. The CDN UUID changes with the extension registration; the asset name and
 * the slug the block renders do not. Matched on the tag itself so an unrelated
 * `assistant.js` from another app can never read as ours.
 */
export async function detectStorefrontEmbed(
  shop: string,
  doFetch: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  slug: string = shopToSlug(shop),
): Promise<EmbedStatus> {
  try {
    const res = await doFetch(`https://${shop}/`, {
      redirect: "follow",
      headers: { accept: "text/html", "user-agent": "BusymateAI-Shopify-App/1.0 (+https://store.busymate.ai)" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 200) return "unknown";
    const html = await res.text();
    if (/action="\/password"|\/password\b/.test(html) && !html.includes("cdn.shopify.com/extensions/")) return "unknown";
    return storefrontLoadsOurEmbed(html, slug) ? "on" : "off";
  } catch {
    return "unknown";
  }
}

/** True when `html` carries a `<script …/assets/assistant.js … data-slug="<slug>">` tag. */
export function storefrontLoadsOurEmbed(html: string, slug: string): boolean {
  if (!slug) return false;
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\bsrc="[^"]*\/extensions\/[^"]*\/assets\/assistant\.js(?:\?[^"]*)?"/i.test(tag)) continue;
    if (tag.includes(`data-slug="${slug}"`)) return true;
  }
  return false;
}

// ---- Home setup checklist ---------------------------------------------------

export type SetupStepId = "provisioned" | "embed" | "trained" | "plan";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  done: boolean;
  failed: boolean;
}

export interface TrainingCounts {
  products: number | null;
  policies: number | null;
  pages: number | null;
}

export interface SetupInput {
  provisionState: string;
  connectorReady: boolean;
  embed: EmbedStatus;
  trainedAt: string | null;
  trainError: string | null;
  /** Items the assistant was trained on (ShopTenant.kb*); null = unknown/never. */
  counts?: TrainingCounts | null;
  /** Items the store has — "N of M" when the catalog was truncated to fit. */
  fetched?: Partial<TrainingCounts> | null;
  truncated?: boolean | null;
  planId: string | null;
  hasSubscription: boolean;
  /** An App Pricing contract exists on Shopify (incl. the $0 Free plan); false = "No plan selected". */
  planSelected?: boolean;
}

/** "62 of 250 products, 3 policies, 4 pages" — the honest training summary. */
export function trainingSummary(counts: TrainingCounts | null | undefined, fetched?: Partial<TrainingCounts> | null): string | null {
  if (!counts || counts.products === null) return null;
  const part = (n: number | null, total: number | null | undefined, noun: string) => {
    const count = n ?? 0;
    const shown = typeof total === "number" && total > count ? `${count} of ${total}` : `${count}`;
    return `${shown} ${noun}`;
  };
  return `${part(counts.products, fetched?.products, "products")}, ${part(counts.policies, fetched?.policies, "policies")}, ${part(counts.pages, fetched?.pages, "pages")}`;
}

/**
 * Human date for "last trained" (ISO → e.g. "2 Sep 2026, 10:00 UTC"). Delegates
 * to the shared deterministic formatter so the app has ONE time-zone-safe render
 * path (#retrain-500). This string is server-rendered into the Home checklist, so
 * it MUST stay UTC-fixed — a bare toLocaleString here would reintroduce the
 * hydration mismatch.
 */
export function formatTrainedAt(iso: string): string {
  return formatServerTime(iso, iso);
}

/** Written steps rendered next to the primary "Turn on" button. */
export const EMBED_STEPS: readonly string[] = [
  "Open your theme editor (Online Store → Themes → Customize).",
  "Open the App embeds panel (the puzzle-piece icon on the left).",
  `Switch on "${APP_EMBED_LABEL}".`,
  "Click Save. The \"Ask us\" launcher appears on every storefront page.",
];

export function buildSetupChecklist(s: SetupInput): SetupStep[] {
  const provisioned = s.provisionState === "published";
  const provisionFailed = s.provisionState === "error";
  const trained = Boolean(s.trainedAt) && !s.trainError;
  const paid = s.hasSubscription && s.planId && s.planId !== "free";
  return [
    {
      id: "provisioned",
      title: "Assistant provisioned",
      detail: provisionFailed
        ? "Provisioning hit an error — retry below."
        : provisioned
          ? s.connectorReady
            ? "Your assistant is live and connected to your store's orders."
            : "Your assistant is live. The order connector is still registering."
          : s.provisionState === "suspended"
            ? "The assistant is suspended (the app was uninstalled). Reinstall or retry to restore it."
            : "Setting up your assistant…",
      done: provisioned,
      failed: provisionFailed,
    },
    {
      id: "embed",
      title: "Storefront assistant switched on",
      detail:
        s.embed === "on"
          ? "The \"Ask us\" launcher is live on your storefront."
          : s.embed === "off"
            ? "Not on yet — the launcher is not loading on your storefront."
            : "Switch the app embed on in your theme editor and click Save — it only stays on once saved (we can't confirm it on a password-protected store).",
      done: s.embed === "on",
      failed: false,
    },
    {
      id: "trained",
      title: "Trained on your store",
      detail: s.trainError
        ? `Training failed: ${s.trainError} — fix the cause, then re-train from Store connection.`
        : trained
          ? `Trained on ${trainingSummary(s.counts, s.fetched) ?? "your products, policies and pages"} · last trained ${formatTrainedAt(s.trainedAt!)} · product changes re-train automatically; re-train from Store connection after policy or page changes.`
          : "Not trained yet — the assistant answers from your products, pages and policies once training completes.",
      done: trained,
      failed: Boolean(s.trainError),
    },
    {
      id: "plan",
      title: "Plan",
      detail: paid
        ? `You're on the ${s.planId!.charAt(0).toUpperCase() + s.planId!.slice(1)} plan.`
        : s.planSelected === false
          ? "No plan selected yet — choose the $0 Free plan or a paid plan on Shopify's pricing page (Billing → Choose a plan). Free-plan limits apply until you do."
          : "You're on the Free plan — 25 resolutions a month, then conversations route to your team. Change plan any time.",
      // Selecting a plan is a one-click step the reviewer/merchant must take on Shopify.
      done: s.planSelected !== false,
      failed: false,
    },
  ];
}
