import { describe, expect, it, vi, afterEach } from "vitest";
import {
  STOREFRONT_ASSISTANT_BLOCK,
  STOREFRONT_ASSISTANT_EXTENSION_UUID,
  buildSetupChecklist,
  detectStorefrontEmbed,
  embedSetupPresentation,
  storefrontLoadsOurEmbed,
  themeEditorActivateUrl,
  themeEditorAppEmbedsUrl,
} from "../app/lib/themeEmbed";

/** Activation identity and CDN asset identity are separate Shopify contracts. */
describe("theme editor deep link", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("activates the block using the deployed app client ID, never the CDN UUID", () => {
    vi.stubEnv("SHOPIFY_API_KEY", "test-app-client-id");
    vi.stubEnv("STOREFRONT_ASSISTANT_EXTENSION_UUID", "different-cdn-id");
    const url = new URL(themeEditorActivateUrl("acme.myshopify.com"));
    expect(url.origin).toBe("https://acme.myshopify.com");
    expect(url.pathname).toBe("/admin/themes/current/editor");
    expect(url.searchParams.get("context")).toBe("apps");
    expect(url.searchParams.get("activateAppId")).toBe("test-app-client-id/assistant");
    expect(url.href).not.toContain(STOREFRONT_ASSISTANT_EXTENSION_UUID);
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

describe("detectStorefrontEmbed (no read_themes scope — reads the public storefront HTML)", () => {
  const html = (body: string, status = 200) =>
    async () => new Response(body, { status, headers: { "content-type": "text/html" } });

  it("reports 'on' when the storefront loads the extension asset", async () => {
    const page = `<html><script src="https://cdn.shopify.com/extensions/${STOREFRONT_ASSISTANT_EXTENSION_UUID}/busymate-ai-4/assets/assistant.js" data-shop="acme.myshopify.com" data-slug="shop-acme" defer></script></html>`;
    expect(await detectStorefrontEmbed("acme.myshopify.com", html(page))).toBe("on");
  });
  it("reports 'off' on a public storefront that does not load it", async () => {
    expect(await detectStorefrontEmbed("acme.myshopify.com", html("<html><body>shop</body></html>"))).toBe("off");
  });
  it("reports 'unknown' (never a false 'off') behind a password page or a non-200", async () => {
    expect(await detectStorefrontEmbed("acme.myshopify.com", html('<form action="/password"></form>'))).toBe("unknown");
    expect(await detectStorefrontEmbed("acme.myshopify.com", html("", 503))).toBe("unknown");
    expect(await detectStorefrontEmbed("acme.myshopify.com", async () => { throw new Error("net"); })).toBe("unknown");
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
    expect(copy.detail).toMatch(/can't confirm/i);
    expect(copy.detail).toMatch(/unconfirmed/i);
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

/**
 * #3718 — Shopify review 5.1.2 (2026-09-24): Home said "Not on yet" while the
 * embed WAS on, because detection matched a stale hard-coded CDN UUID
 * (`01a04ae4…`) and the live extension serves from `01a061be-…`.
 */
describe("detectStorefrontEmbed matches the asset + this store's slug, never a CDN UUID (#3718)", () => {
  const html = (body: string) => async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  const tag = (uuid: string, slug: string) =>
    `<script src="https://cdn.shopify.com/extensions/${uuid}/busymate-ai-5/assets/assistant.js" data-shop="x" data-slug="${slug}" data-origin="https://busymate.ai" defer></script>`;

  it("the LIVE extension UUID (01a061be-…) reads 'on'", async () => {
    const page = `<html><body>${tag("01a061be-71c0-7659-afb4-b5e0d5ef3c3e", "shop-acme")}</body></html>`;
    expect(await detectStorefrontEmbed("acme.myshopify.com", html(page))).toBe("on");
  });

  it("ANY future extension registration still reads 'on' — the UUID is not the identity", async () => {
    const page = `<html><body>${tag("99999999-0000-4000-8000-000000000000", "shop-acme")}</body></html>`;
    expect(await detectStorefrontEmbed("acme.myshopify.com", html(page))).toBe("on");
  });

  it("another store's slug, or another app's assistant.js, is NOT ours", async () => {
    expect(await detectStorefrontEmbed("acme.myshopify.com", html(`<html>${tag("01a061be", "shop-other")}</html>`))).toBe("off");
    const foreign = `<html><script src="https://cdn.shopify.com/extensions/abc/other-app-1/assets/assistant.js"></script></html>`;
    expect(await detectStorefrontEmbed("acme.myshopify.com", html(foreign))).toBe("off");
  });

  it("an explicit slug (the tenant's stored slug) is honoured", async () => {
    const page = `<html>${tag("01a061be", "shop-custom-slug")}</html>`;
    expect(await detectStorefrontEmbed("acme.myshopify.com", html(page), "shop-custom-slug")).toBe("on");
  });

  it("storefrontLoadsOurEmbed ignores a slug that only appears outside the script tag", () => {
    const page = `<html><p>data-slug="shop-acme"</p><script src="https://cdn.shopify.com/extensions/u/v/assets/assistant.js"></script></html>`;
    expect(storefrontLoadsOurEmbed(page, "shop-acme")).toBe(false);
    expect(storefrontLoadsOurEmbed(page, "")).toBe(false);
  });
});
