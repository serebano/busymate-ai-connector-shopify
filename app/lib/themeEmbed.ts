/**
 * Theme app-embed onboarding (App Store Req 5.1.3) — the ONE thing a merchant
 * must do after install: enable the "AI support chat" app embed in
 * Theme editor → App embeds. This module owns the deep link, the setup
 * checklist Home renders and the embed-state mapping.
 *
 * Activation uses SHOPIFY_API_KEY (the app client_id), not a CDN asset UUID.
 * Shopify deprecated extension UUID activation links.
 * https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
 *
 * Embed state (G2, BFS 4.2.3): Home asks App Bridge — `shopify.app.extensions()`
 * returns each block's activation status on the store's PUBLISHED theme and
 * "requires no additional access scopes" (configuration doc above;
 * https://shopify.dev/docs/api/app-home/apis/app). It works the same on a
 * password-protected store, needs no `read_themes`, no server round-trip and no
 * "it's switched on" confirmation from the merchant.
 */

/** The theme extension's handle (extensions/storefront-assistant/shopify.extension.toml). */
export const STOREFRONT_ASSISTANT_EXTENSION = "storefront-assistant";
/** blocks/assistant.liquid → the block handle in `activateAppId=<client_id>/<block>`. */
export const STOREFRONT_ASSISTANT_BLOCK = "assistant";
/**
 * The app embed's name as listed in Theme editor → App embeds (schema `name`,
 * locales/en.default.schema.json). G9: under 25 characters and WITHOUT the app
 * title — Shopify shows the app title under it ("Don't include the title of your
 * app in the name of the block", configuration doc above).
 */
export const APP_EMBED_LABEL = "AI support chat";

/**
 * Review2 D5 (2026-11-26) — the first open of the old link
 * (`https://<shop>/admin/themes/current/editor?…`, an <a target="_top">) reloaded the whole
 * admin through the myshopify.com → admin.shopify.com redirect, and the editor once showed
 * "Failed to load the page" (Page is redirecting to an unsupported URL). The link is now
 * Shopify's documented app-embed deep link (`context=apps&template=index&activateAppId=
 * <api_key>/<block handle>`) addressed as `shopify://admin/…`, which App Bridge opens INSIDE
 * the admin (no top-level reload, no redirect). Measured 2026-11-26 on review2-sim-1126:
 * `open("shopify://admin/themes/current/editor?…", "_top")` from the app frame lands on
 * admin.shopify.com/store/<store>/themes/<id>/editor?context=apps&appEmbed=<key>/assistant
 * with the embed switched on.
 */
export const THEME_EDITOR_TEMPLATE = "index";

/** Theme editor with the app embed pre-activated (merchant still clicks Save). */
export function themeEditorActivateUrl(_shop: string, opts: { apiKey?: string; block?: string } = {}): string {
  const apiKey = (opts.apiKey ?? process.env.SHOPIFY_API_KEY ?? "").trim();
  // Without app identity, open the manual app-embeds panel instead of a dead link.
  if (!apiKey) return themeEditorAppEmbedsUrl(_shop);
  const block = opts.block ?? STOREFRONT_ASSISTANT_BLOCK;
  return `${themeEditorAppEmbedsUrl(_shop)}&activateAppId=${encodeURIComponent(apiKey)}/${encodeURIComponent(block)}`;
}

/** Theme editor → App embeds panel, opened inside the admin by App Bridge. */
export function themeEditorAppEmbedsUrl(_shop: string): string {
  return `shopify://admin/themes/current/editor?context=apps&template=${THEME_EDITOR_TEMPLATE}`;
}

/**
 * Review2 D9 — Home's header badge said "Live" while the embed was Off (step "To do", card
 * "Off"). The assistant is only live for shoppers when the embed is on, so a published
 * assistant with the embed off/unknown says so instead of "Live".
 */
export function homeHeaderStatus(provisionState: string, embed: EmbedStatus): { label: string; tone: "success" | "attention" | "info" } | null {
  if (provisionState !== "published") return null; // the provisioning badges speak for themselves
  if (embed === "on") return { label: "Live", tone: "success" };
  if (embed === "off") return { label: "Not on storefront yet", tone: "attention" };
  return { label: "Checking storefront", tone: "info" };
}

/**
 * `checking` — App Bridge has not answered yet (first paint);
 * `unknown` — App Bridge could not answer (outside Shopify Admin, or an error).
 */
export type EmbedStatus = "on" | "off" | "unknown" | "checking";

/** The subset of App Bridge's `ExtensionInfo` this module reads. */
export interface ExtensionInfoLike {
  handle: string;
  type: string;
  /** Theme blocks/embeds carry `handle` + `status`; UI-extension activations do not. */
  activations?: ReadonlyArray<object> | null;
}

/**
 * `shopify.app.extensions()` → our app embed's state on the published theme:
 * `active` → on; `available` (present, not switched on) or `unavailable` → off;
 * null when the answer does not list our embed at all.
 */
export function embedFromExtensions(extensions: ReadonlyArray<ExtensionInfoLike> | null | undefined): "on" | "off" | null {
  if (!Array.isArray(extensions)) return null;
  // Live App Bridge (0.41.x, 2026-11-26) reports our theme extension with handle
  // "theme-app-extension", not the toml handle "storefront-assistant", so match the
  // theme extension by type and the embed by its block handle (the app has ONE theme
  // extension). Our own handle still wins when Shopify does report it.
  const themeExts = extensions.filter((e) => e?.type === "theme_app_extension");
  const ordered = [
    ...themeExts.filter((e) => e.handle === STOREFRONT_ASSISTANT_EXTENSION),
    ...themeExts.filter((e) => e.handle !== STOREFRONT_ASSISTANT_EXTENSION),
  ];
  const block = ordered
    .flatMap((e) => (Array.isArray(e.activations) ? (e.activations as ReadonlyArray<{ handle?: unknown; status?: unknown }>) : []))
    .find((a) => a?.handle === STOREFRONT_ASSISTANT_BLOCK);
  if (!block) return null;
  return block.status === "active" ? "on" : "off";
}

/**
 * The embed state Home renders FIRST (F5, admin CLS): the last App Bridge answer
 * the app stored (`ShopTenant.embedConfirmedAt` set = on). Never "checking" —
 * that placeholder changed the card's and checklist's height once App Bridge
 * answered (CLS 0.13 on a 390 px admin). A never-checked shop starts "off",
 * which is what a fresh install has.
 */
export function lastKnownEmbed(embedConfirmedAt: Date | string | null | undefined): "on" | "off" {
  return embedConfirmedAt ? "on" : "off";
}

/** `POST /api/embed-status` body → a definite state, or null (refused, no write). */
export function parseEmbedStatus(body: unknown): "on" | "off" | null {
  const status = (body as { status?: unknown } | null)?.status;
  return status === "on" || status === "off" ? status : null;
}

/** Home's embed card copy for each state. */
export function embedSetupPresentation(status: EmbedStatus) {
  if (status === "on") {
    return {
      heading: "Storefront assistant is on",
      detail: `"${APP_EMBED_LABEL}" is switched on in your published theme, so the "Ask us" launcher shows on your storefront. Open App embeds to review it; click Save if you make a change.`,
      button: "Review in App embeds",
      activationLink: false,
    };
  }
  if (status === "off") {
    return {
      heading: "Turn on the storefront assistant",
      detail: `"${APP_EMBED_LABEL}" is not switched on in your published theme yet. Open the theme editor, switch it on, and click Save. This page updates when you come back.`,
      button: "Turn on the storefront assistant",
      activationLink: true,
    };
  }
  if (status === "checking") {
    return {
      heading: "Checking your theme",
      detail: `Checking whether "${APP_EMBED_LABEL}" is switched on in your published theme.`,
      button: "Turn on the storefront assistant",
      activationLink: true,
    };
  }
  return {
    heading: "Check storefront assistant status",
    detail: `We couldn't read your theme's app embeds just now. Open App embeds, switch on "${APP_EMBED_LABEL}" if it is off, and click Save. This page checks again when you come back.`,
    button: "Check in App embeds",
    activationLink: false,
  };
}

/** The checklist's embed step for a state (Home recomputes it once App Bridge answers). */
export function embedStep(embed: EmbedStatus): SetupStep {
  return {
    id: "embed",
    title: "Storefront assistant switched on",
    detail:
      embed === "on"
        ? "Switched on in your published theme. The \"Ask us\" launcher shows on your storefront."
        : embed === "off"
          ? "Not on yet. Switch the app embed on in your theme editor and click Save."
          : embed === "checking"
            ? "Checking your theme…"
            : "Couldn't check your theme just now. Switch the app embed on in your theme editor and click Save; this page checks again when you come back.",
    done: embed === "on",
    failed: false,
  };
}

// ---- Home setup checklist ---------------------------------------------------

export type SetupStepId = "provisioned" | "embed" | "trained" | "plan";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  done: boolean;
  failed: boolean;
  /**
   * Review nit N2 (2026-10-24): Home printed "08:02 UTC" while every other page shows
   * the merchant's local time. An instant in `detail` is written as AT_MARKER and the
   * page renders it with <LocalTime> (SSR-safe), the same as Store connection.
   */
  at?: string;
}

/** Where a step's `at` instant goes inside its `detail` text. */
export const AT_MARKER = "{at}";

export interface TrainingCounts {
  products: number | null;
  policies: number | null;
  pages: number | null;
}

export interface SetupInput {
  provisionState: string;
  connectorReady: boolean;
  /** Server render: "checking"; Home swaps in the App Bridge answer (embedStep). */
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
    embedStep(s.embed),
    {
      id: "trained",
      title: "Trained on your store",
      detail: s.trainError
        ? `Training failed: ${s.trainError} — fix the cause, then re-train from Store connection.`
        : trained
          ? `Trained on ${trainingSummary(s.counts, s.fetched) ?? "your products, policies and pages"} · last trained ${AT_MARKER} · product changes re-train automatically; re-train from Store connection after policy or page changes.`
          : "Not trained yet — the assistant answers from your products, pages and policies once training completes.",
      done: trained,
      failed: Boolean(s.trainError),
      ...(trained && s.trainedAt ? { at: s.trainedAt } : {}),
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
