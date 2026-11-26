import { describe, expect, it, vi, afterEach } from "vitest";
import {
  APP_EMBED_LABEL,
  STOREFRONT_ASSISTANT_BLOCK,
  STOREFRONT_ASSISTANT_EXTENSION,
  buildSetupChecklist,
  embedFromExtensions,
  embedSetupPresentation,
  embedStep,
  themeEditorActivateUrl,
  themeEditorAppEmbedsUrl,
} from "../app/lib/themeEmbed";

/** Activation identity and CDN asset identity are separate Shopify contracts. */
describe("theme editor deep link", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("activates the block using the deployed app client ID, never the CDN UUID", () => {
    vi.stubEnv("SHOPIFY_API_KEY", "test-app-client-id");

    const url = new URL(themeEditorActivateUrl("acme.myshopify.com"));
    expect(url.origin).toBe("https://acme.myshopify.com");
    expect(url.pathname).toBe("/admin/themes/current/editor");
    expect(url.searchParams.get("context")).toBe("apps");
    expect(url.searchParams.get("activateAppId")).toBe("test-app-client-id/assistant");
    expect(url.href).not.toContain("01a061be");
    expect(STOREFRONT_ASSISTANT_BLOCK).toBe("assistant");
  });

  it("uses explicit app identity and safely encodes the block handle", () => {
    const url = new URL(themeEditorActivateUrl("acme.myshopify.com", { apiKey: "another-client", block: "assistant&other" }));
    expect(url.searchParams.get("activateAppId")).toBe("another-client/assistant&other");
    expect(url.searchParams.has("other")).toBe(false);
  });

  it("falls back to manual app embeds when app identity is unavailable", () => {
    vi.stubEnv("SHOPIFY_API_KEY", "  ");
    expect(themeEditorActivateUrl("acme.myshopify.com")).toBe(themeEditorAppEmbedsUrl("acme.myshopify.com"));
    expect(themeEditorAppEmbedsUrl("acme.myshopify.com")).toBe("https://acme.myshopify.com/admin/themes/current/editor?context=apps");
  });
});

describe("buildSetupChecklist (Home)", () => {
  it("orders the four steps and marks them from the tenant state", () => {
    const steps = buildSetupChecklist({
      provisionState: "published",
      connectorReady: true,
      embed: "on",
      trainedAt: "2026-09-02T00:00:00Z",
      trainError: null,
      planId: "growth",
      hasSubscription: true,
    });
    expect(steps.map((s) => s.id)).toEqual(["provisioned", "embed", "trained", "plan"]);
    expect(steps.every((s) => s.done)).toBe(true);
  });
  it("a fresh install has only 'plan' resolved (Free) and the embed step pending", () => {
    const steps = buildSetupChecklist({
      provisionState: "published",
      connectorReady: false,
      embed: "unknown",
      trainedAt: null,
      trainError: null,
      planId: null,
      hasSubscription: false,
    });
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId.provisioned.done).toBe(true);
    expect(byId.embed.done).toBe(false);
    expect(byId.trained.done).toBe(false);
    expect(byId.plan.done).toBe(true); // Free plan — nothing the merchant must do
    expect(byId.plan.detail).toMatch(/Free plan/);
  });
  it("a provisioning error is surfaced as the first, failed step", () => {
    const steps = buildSetupChecklist({
      provisionState: "error",
      connectorReady: false,
      embed: "unknown",
      trainedAt: null,
      trainError: null,
      planId: null,
      hasSubscription: false,
    });
    expect(steps[0]).toMatchObject({ id: "provisioned", done: false, failed: true });
  });
  it("the trained step reads 'Trained on N products, M policies, K pages' with the counts + the re-train hint", () => {
    const steps = buildSetupChecklist({
      provisionState: "published",
      connectorReady: true,
      embed: "on",
      trainedAt: "2026-09-02T10:00:00.000Z",
      trainError: null,
      counts: { products: 62, policies: 3, pages: 4 },
      truncated: true,
      fetched: { products: 250, policies: 3, pages: 4 },
      planId: null,
      hasSubscription: false,
    });
    const trained = steps.find((s) => s.id === "trained")!;
    expect(trained.done).toBe(true);
    expect(trained.detail).toMatch(/Trained on 62 of 250 products, 3 policies, 4 pages/);
    expect(trained.detail).toMatch(/[Rr]e-train/);
  });
  it("a training error is a failed step whose detail carries the error and the re-train hint", () => {
    const steps = buildSetupChecklist({
      provisionState: "published",
      connectorReady: true,
      embed: "on",
      trainedAt: null,
      trainError: "Shopify Admin 403",
      counts: { products: null, policies: null, pages: null },
      planId: null,
      hasSubscription: false,
    });
    const trained = steps.find((s) => s.id === "trained")!;
    expect(trained).toMatchObject({ done: false, failed: true });
    expect(trained.detail).toMatch(/Shopify Admin 403/);
    expect(trained.detail).toMatch(/[Rr]e-train/);
  });
});

describe("Home embed instructions", () => {
  it("does not tell merchants the embed is on when the storefront status is unknown", () => {
    const copy = embedSetupPresentation("unknown");
    expect(copy.heading).toBe("Check storefront assistant status");
    expect(copy.detail).toMatch(/couldn't read/i);
    expect(copy.detail).not.toMatch(/already switched on|is loading on your storefront/i);
    expect(copy.button).toBe("Check in App embeds");
    expect(copy.activationLink).toBe(false);
  });

  it("offers activation only for a confirmed-off embed and review for a confirmed-on embed", () => {
    expect(embedSetupPresentation("off")).toMatchObject({
      heading: "Turn on the storefront assistant",
      button: "Turn on the storefront assistant",
      activationLink: true,
    });
    expect(embedSetupPresentation("on")).toMatchObject({
      heading: "Storefront assistant is on",
      button: "Review in App embeds",
      activationLink: false,
    });
  });
});

describe("#2624 reviewer W3 — training summary plurals", () => {
  it("one policy, one page, one product read singular; others plural", async () => {
    const { trainingSummary } = await import("../app/lib/themeEmbed");
    expect(trainingSummary({ products: 15, policies: 1, pages: 2 }, { products: 17, policies: 1, pages: 2 })).toBe("15 of 17 products, 1 policy, 2 pages");
    expect(trainingSummary({ products: 1, policies: 0, pages: 1 })).toBe("1 product, 0 policies, 1 page");
    expect(trainingSummary({ products: 1, policies: 3, pages: 0 }, { products: 2 })).toBe("1 of 2 products, 3 policies, 0 pages");
  });
});

describe("G2 — embed state from App Bridge shopify.app.extensions() (no read_themes)", () => {
  const ours = (status: string) => [
    { handle: "some-ui-ext", type: "ui_extension", activations: [] },
    { handle: STOREFRONT_ASSISTANT_EXTENSION, type: "theme_app_extension", activations: [{ handle: STOREFRONT_ASSISTANT_BLOCK, name: APP_EMBED_LABEL, target: "body", status, activations: [] }] },
  ];
  it("active → on; available / unavailable → off (published theme only)", () => {
    expect(STOREFRONT_ASSISTANT_EXTENSION).toBe("storefront-assistant");
    expect(embedFromExtensions(ours("active"))).toBe("on");
    expect(embedFromExtensions(ours("available"))).toBe("off");
    expect(embedFromExtensions(ours("unavailable"))).toBe("off");
  });
  it("null when the answer does not list OUR embed (never a false on/off)", () => {
    expect(embedFromExtensions([])).toBeNull();
    expect(embedFromExtensions(null)).toBeNull();
    expect(embedFromExtensions([{ handle: STOREFRONT_ASSISTANT_EXTENSION, type: "theme_app_extension", activations: [{ handle: "other-block", status: "active" }] }])).toBeNull();
    expect(embedFromExtensions([{ handle: STOREFRONT_ASSISTANT_EXTENSION, type: "ui_extension", activations: [] }])).toBeNull();
  });
  it("reads the live App Bridge answer, which names the theme extension \"theme-app-extension\" (not the toml handle)", () => {
    // Captured from shopify.app.extensions() on northpeak-review-14 after busymate-ai-12 (2026-11-26, App Bridge 0.41.6).
    const live = (status: string) => [
      { handle: "theme-app-extension", type: "theme_app_extension", activations: [{ target: "body", handle: "assistant", name: "AI support chat", status, activations: [{ target: "theme/4921784256407975851", themeId: "gid://shopify/OnlineStoreTheme/190033887285" }] }] },
    ];
    expect(embedFromExtensions(live("active"))).toBe("on");
    expect(embedFromExtensions(live("available"))).toBe("off");
    expect(embedFromExtensions([{ handle: "theme-app-extension", type: "theme_app_extension", activations: [] }])).toBeNull();
  });
  it("the checklist step is Done only on 'on'; no state asks the merchant to confirm by hand", () => {
    expect(embedStep("on")).toMatchObject({ id: "embed", done: true, failed: false });
    for (const st of ["off", "unknown", "checking"] as const) {
      const step = embedStep(st);
      expect(step.done).toBe(false);
      expect(step.detail).not.toMatch(/It's switched on|confirm/i);
      expect(embedSetupPresentation(st).detail).not.toMatch(/It's switched on|password/i);
    }
    expect(embedStep("checking").detail).toMatch(/Checking/);
    expect(buildSetupChecklist({ provisionState: "published", connectorReady: true, embed: "checking", trainedAt: null, trainError: null, planId: null, hasSubscription: false })[1]).toEqual(embedStep("checking"));
  });
});

describe("G9 — app embed name (theme editor) is short and has no app title", () => {
  it("every locale's schema name is under 25 characters and never names the app", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = "extensions/storefront-assistant/locales";
    const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
    expect(files).toHaveLength(14);
    for (const f of files) {
      const name = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).name as string;
      expect([...name].length, f).toBeLessThan(25);
      expect(name, f).not.toMatch(/busymate/i);
    }
    expect(JSON.parse(readFileSync(`${dir}/en.default.schema.json`, "utf8")).name).toBe(APP_EMBED_LABEL);
  });
});
