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
 * src#2624 reviewer F25: the embed state is read from the THEME itself
 * (`read_themes`: the main theme's config/settings_data.json — is our app-embed
 * block present and not disabled?), so a password-protected store, a reinstall or
 * an embed switched off later is always seen as it is. No stored "it's on"
 * confirmation exists any more. The public-storefront check stays only as the
 * fallback when the theme cannot be read (e.g. before the scope is granted).
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

/**
 * Our app-embed block in a theme's settings_data.json → "on" (present and not
 * disabled) or "off". settings_data.json may open with a comment header.
 * Block types look like `shopify://apps/<app-handle>/blocks/assistant/<extension-uuid>`.
 */
export function embedFromSettingsData(content: string, appHandle = process.env.SHOPIFY_APP_HANDLE || "busymate-ai"): "on" | "off" | null {
  let data: { current?: unknown } | null = null;
  try {
    data = JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, "")) as { current?: unknown };
  } catch {
    return null;
  }
  const current = data && typeof data.current === "object" && data.current ? (data.current as { blocks?: Record<string, { type?: string; disabled?: boolean }> }) : null;
  if (!current) return "off";
  const ours = Object.values(current.blocks ?? {}).filter((b) => typeof b?.type === "string" && b.type.startsWith(`shopify://apps/${appHandle}/blocks/${STOREFRONT_ASSISTANT_BLOCK}/`));
  return ours.some((b) => b.disabled !== true) ? "on" : "off";
}

type ThemeGraphql = (query: string) => Promise<Response>;

/** The main theme's app-embed state via Admin GraphQL (needs `read_themes`); null when it cannot be read. */
export async function readThemeEmbed(graphql: ThemeGraphql): Promise<"on" | "off" | null> {
  try {
    const res = await graphql(`#graphql
      query MainThemeSettings {
        themes(first: 1, roles: [MAIN]) {
          nodes { files(filenames: ["config/settings_data.json"], first: 1) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } } } }
        }
      }`);
    const body = (await res.json()) as { data?: { themes?: { nodes?: Array<{ files?: { nodes?: Array<{ body?: { content?: string } }> } }> } } };
    const content = body.data?.themes?.nodes?.[0]?.files?.nodes?.[0]?.body?.content;
    return typeof content === "string" ? embedFromSettingsData(content) : null;
  } catch {
    return null;
  }
}

/** Theme editor → App embeds panel (fallback when the deep link is stale). */
export function themeEditorAppEmbedsUrl(shop: string): string {
  return `https://${shop}/admin/themes/current/editor?context=apps`;
}

/**
 * `password` (#2618 follow-up): the storefront answered with Shopify's password
 * page, so its theme (and our embed) cannot be seen from outside. The merchant
 * can confirm it themselves; we re-check once the password is removed.
 */
export type EmbedStatus = "on" | "off" | "unknown" | "password";

/** Home instructions must reflect what the scope-free storefront check knows. */
export function embedSetupPresentation(status: EmbedStatus, confirmed = false) {
  if (status === "password") {
    return confirmed
      ? {
          heading: "Storefront assistant is on (confirmed by you)",
          detail: "You confirmed the app embed is switched on and saved. Your store is password-protected, so we can't see the storefront from outside; we check it by ourselves once the password is removed.",
          button: "Review in App embeds",
          activationLink: false,
        }
      : {
          heading: "Your store is password-protected",
          detail: "We couldn't read your theme just now. Open App embeds, switch on \"Busymate AI assistant\" and click Save; this page re-checks your theme by itself.",
          button: "Open App embeds",
          activationLink: true,
        };
  }
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
    if (/action="\/password"|\/password\b/.test(html) && !html.includes("cdn.shopify.com/extensions/")) return "password";
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
  /** The merchant confirmed the embed is on (only meaningful while the storefront is password-protected). */
  embedConfirmed?: boolean;
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

/** "62 of 250 products, 1 policy, 4 pages" — the honest training summary (plural-aware). */
const NOUNS = {
  products: { one: "product", other: "products" },
  policies: { one: "policy", other: "policies" },
  pages: { one: "page", other: "pages" },
} as const;
const PLURAL = new Intl.PluralRules("en");
export function countNoun(n: number, noun: keyof typeof NOUNS): string {
  return NOUNS[noun][PLURAL.select(n) === "one" ? "one" : "other"];
}

export function trainingSummary(counts: TrainingCounts | null | undefined, fetched?: Partial<TrainingCounts> | null): string | null {
  if (!counts || counts.products === null) return null;
  const part = (n: number | null, total: number | null | undefined, noun: keyof typeof NOUNS) => {
    const count = n ?? 0;
    const partial = typeof total === "number" && total > count;
    // "1 of 2 products" reads by the total; a bare count by itself.
    return `${partial ? `${count} of ${total}` : `${count}`} ${countNoun(partial ? total : count, noun)}`;
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
            : "Setting up: creating your assistant and learning your products, pages and policies. This usually takes a few seconds; this page updates by itself.",
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
            : s.embed === "password"
              ? s.embedConfirmed
                ? "You confirmed it's on. Your store is password-protected, so we'll check it ourselves once the password is removed."
                : "We couldn't read your theme just now. Switch the app embed on in your theme editor and click Save; this page re-checks by itself."
              : "Switch the app embed on in your theme editor and click Save — it only stays on once saved.",
      done: s.embed === "on" || (s.embed === "password" && Boolean(s.embedConfirmed)),
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
