import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Expiring offline tokens (#2110) — the config contract in app/shopify.server.ts
 * + package.json. Shopify rejects non-expiring offline tokens for public apps
 * created after 2026-04-01 ("[API] Non-expiring access tokens are no longer
 * accepted"), so the app MUST run @shopify/shopify-app-react-router ≥2 with
 * `future.expiringOfflineAccessTokens: true`. The compiler (`npm run typecheck`)
 * rejects the removed v0/v1 options; this test pins the intent so a future
 * "cleanup" cannot silently flip the flag off or reintroduce the redundant
 * per-install registerWebhooks call (subscriptions are toml-declared).
 */
const root = join(__dirname, "..");
const server = readFileSync(join(root, "app/shopify.server.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("app/shopify.server.ts", () => {
  it("opts in to expiring offline access tokens", () => {
    const future = server.match(/future:\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(future).toMatch(/expiringOfflineAccessTokens:\s*true/);
  });

  it("carries none of the options removed in v2 (they were the v1 defaults)", () => {
    expect(server).not.toMatch(/unstable_newEmbeddedAuthStrategy/);
    expect(server).not.toMatch(/removeRest/);
    expect(server).not.toMatch(/customShopDomains/);
  });

  it("afterAuth no longer re-registers toml-declared webhooks per install", () => {
    const afterAuth = server.match(/afterAuth:[\s\S]*?\n\s{4}\},/)?.[0] ?? "";
    expect(afterAuth).not.toMatch(/registerWebhooks\(/);
    // #3718 — the hook goes through the idempotency guard, never the raw lifecycle.
    expect(afterAuth).toMatch(/onAfterAuth\(session\)/);
    expect(afterAuth).not.toMatch(/onAppInstalled\(session\)/);
  });
});

describe("package.json", () => {
  it("pins the consistent Shopify library set and drops the shopify-api override", () => {
    expect(pkg.dependencies["@shopify/shopify-app-react-router"]).toBe("2.1.0");
    expect(pkg.dependencies["@shopify/shopify-app-session-storage-prisma"]).toBe("10.0.1");
    expect(pkg.dependencies["@shopify/shopify-api"]).toBe("14.0.1");
    expect(pkg.overrides).toBeUndefined();
  });

  it("requires Node ≥22 (the library floor) and builds in production mode", () => {
    expect(pkg.engines.node).toMatch(/>=\s*22/);
    expect(pkg.scripts.build).toMatch(/NODE_ENV=production/);
  });
});
