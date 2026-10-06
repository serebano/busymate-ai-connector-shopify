import { describe, expect, it, vi } from "vitest";
import {
  THEME_EDITOR_ANCESTORS,
  embedCtaReady,
  recheckDelayMs,
  recheckIsSlow,
  embedStatusUrl,
  foldFrameable,
  parseEmbedStatus,
  readStorefrontFrameable,
} from "../app/lib/embedFrameable";

/**
 * #3718 — Home offers "Turn on the storefront assistant" only once the chat can
 * actually be framed in the Online Store AND the Theme Editor (the reviewers
 * turned the embed on during activation and got "refused to connect").
 */
describe("embed frameability (#3718)", () => {
  it("asks the platform with the store origin, and with the full Theme Editor chain", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ v: 1, frameable: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await readStorefrontFrameable({ platformOrigin: "https://busymate.ai", shop: "demo.myshopify.com", slug: "shop-demo" }, fetchImpl);
    expect(result).toBe(true);
    const chains = urls.map((u) => new URL(u).searchParams.get("ancestors"));
    expect(chains).toEqual([
      "https://demo.myshopify.com",
      ["https://demo.myshopify.com", ...THEME_EDITOR_ANCESTORS].join(","),
    ]);
    expect(new URL(urls[0]!).searchParams.get("assistant")).toBe("shop-demo");
  });

  it("a refusal in EITHER place is a no (the editor chain alone refused)", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ frameable: n++ === 0 }) }) as unknown as Response) as unknown as typeof fetch;
    expect(await readStorefrontFrameable({ platformOrigin: "https://busymate.ai", shop: "d.myshopify.com", slug: "shop-d" }, fetchImpl)).toBe(false);
  });

  it("a platform that cannot answer (network error, 5xx, no endpoint yet) is unknown, never a no", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await readStorefrontFrameable({ platformOrigin: "https://busymate.ai", shop: "d.myshopify.com", slug: "shop-d" }, down)).toBeNull();
    const notFound = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    expect(await readStorefrontFrameable({ platformOrigin: "https://busymate.ai", shop: "d.myshopify.com", slug: "shop-d" }, notFound)).toBeNull();
  });

  it("parses only a boolean frameable", () => {
    expect(parseEmbedStatus({ frameable: true })).toBe(true);
    expect(parseEmbedStatus({ frameable: false })).toBe(false);
    expect(parseEmbedStatus({ frameable: null })).toBeNull();
    expect(parseEmbedStatus({ frameable: "true" })).toBeNull();
    expect(parseEmbedStatus(null)).toBeNull();
  });

  it("folds: any no wins, then unknown, else yes", () => {
    expect(foldFrameable([true, true])).toBe(true);
    expect(foldFrameable([true, false])).toBe(false);
    expect(foldFrameable([null, false])).toBe(false);
    expect(foldFrameable([true, null])).toBeNull();
    expect(foldFrameable([])).toBe(false);
  });

  // #3718 review defect 4 — the platform's frameability answer decides whenever
  // it answered; readiness decides only when the platform could not be asked,
  // and then only a definite "not yet" holds the 5.1.3 onboarding deep link.
  it("frameable === true enables the CTA whatever the readiness read says", () => {
    for (const state of ["ready", "pending", "unverified", "orphaned", "error", null] as const) {
      expect(embedCtaReady(state, true), String(state)).toBe(true);
    }
  });

  it("frameable === false holds the CTA whatever the readiness read says", () => {
    for (const state of ["ready", "pending", "unverified", "orphaned", "error", null] as const) {
      expect(embedCtaReady(state, false), String(state)).toBe(false);
    }
  });

  it("an unanswered frameability check never blocks on 'couldn't ask'", () => {
    expect(embedCtaReady("ready", null)).toBe(true);
    expect(embedCtaReady("unverified", null)).toBe(true);
    expect(embedCtaReady("pending", null)).toBe(false);
    expect(embedCtaReady("orphaned", null)).toBe(false);
    expect(embedCtaReady("error", null)).toBe(false);
  });

  it("re-checks every 5 s for 5 minutes, then every 30 s — never stops", () => {
    expect(recheckDelayMs(0)).toBe(5_000);
    expect(recheckDelayMs(59)).toBe(5_000);
    expect(recheckDelayMs(60)).toBe(30_000);
    expect(recheckDelayMs(10_000)).toBe(30_000);
    expect(recheckIsSlow(59)).toBe(false);
    expect(recheckIsSlow(60)).toBe(true);
    // 60 fast ticks ≈ 5 minutes.
    expect(60 * recheckDelayMs(0)).toBe(300_000);
  });

  it("asks each custom storefront domain as its own ancestor when given", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(new URL(url).searchParams.get("ancestors") ?? "");
      const refused = url.includes("www.brand.example");
      return { ok: true, json: async () => ({ frameable: !refused }) };
    }) as unknown as typeof fetch;
    const out = await readStorefrontFrameable({ platformOrigin: "https://busymate.ai", shop: "d.myshopify.com", slug: "shop-d", domains: ["www.brand.example"] }, fetchImpl);
    expect(asked).toContain("https://www.brand.example");
    expect(out).toBe(false);
  });

  it("builds the public endpoint URL on the platform origin", () => {
    expect(embedStatusUrl("https://busymate.ai", "shop-x", ["https://x.myshopify.com"])).toBe(
      "https://busymate.ai/api/embed-status?assistant=shop-x&ancestors=https%3A%2F%2Fx.myshopify.com",
    );
  });
});
