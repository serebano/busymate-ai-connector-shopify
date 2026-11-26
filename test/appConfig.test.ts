import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * shopify.app.toml contract (#2110): the storefront widget POSTs its identity
 * request to a Shopify App-Proxy path (`/apps/<subpath>/identity`), which only
 * resolves when the toml declares a matching [app_proxy]. Without it the fetch
 * 404s on every store and the identified-customer tier (order-aware answers)
 * is unreachable — the listing's headline claim. Pin the three sides together:
 * toml proxy path == the extension's IDENTITY_URL == the app's /identity route.
 */
const root = join(__dirname, "..");
const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");
const assistantJs = readFileSync(
  join(root, "extensions/storefront-assistant/assets/assistant.js"),
  "utf8",
);

function tomlSection(name: string): string {
  const m = toml.match(new RegExp(`^\\[${name}\\]\\n([\\s\\S]*?)(?=^\\[|\\Z)`, "m"));
  if (!m) throw new Error(`[${name}] missing from shopify.app.toml`);
  return m[1];
}
function tomlValue(section: string, key: string): string {
  const m = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
  if (!m) throw new Error(`${key} missing`);
  return m[1];
}

describe("shopify.app.toml [app_proxy]", () => {
  it("is declared and points at this app", () => {
    const proxy = tomlSection("app_proxy");
    const appUrl = toml.match(/^application_url\s*=\s*"([^"]+)"/m)![1];
    expect(tomlValue(proxy, "url")).toBe(appUrl);
    expect(tomlValue(proxy, "prefix")).toBe("apps");
    expect(tomlValue(proxy, "subpath")).toBe("busymate-ai");
  });

  it("proxy path equals the theme extension's IDENTITY_URL", () => {
    const proxy = tomlSection("app_proxy");
    const proxied = `/${tomlValue(proxy, "prefix")}/${tomlValue(proxy, "subpath")}/identity`;
    const identityUrl = assistantJs.match(/IDENTITY_URL\s*=\s*"([^"]+)"/)![1];
    expect(identityUrl).toBe(proxied);
  });

  it("Shopify forwards the remainder (/identity) to an existing app route", () => {
    // /apps/busymate-ai/identity → <url>/identity → app/routes/identity.tsx
    expect(existsSync(join(root, "app/routes/identity.tsx"))).toBe(true);
  });
});

/**
 * Grounding (#2110): the training query (app/lib/kbFetch.ts) reads products,
 * pages (read_content) and Shop.shopPolicies — which Shopify gates behind
 * `read_legal_policies`. A missing scope makes the WHOLE ingest fail with
 * "Access denied", so the toml scopes are pinned to what the query needs.
 */
describe("shopify.app.toml [access_scopes] cover the training query", () => {
  const scopes = tomlValue(tomlSection("access_scopes"), "scopes").split(",").map((s) => s.trim());
  it.each([
    ["products", "read_products"],
    ["pages", "read_content"],
    ["shopPolicies", "read_legal_policies"],
  ])("KB_INGEST_QUERY reads %s → scope %s is requested", async (field, scope) => {
    const { KB_INGEST_QUERY } = await import("../app/lib/kbFetch");
    expect(KB_INGEST_QUERY).toContain(field);
    expect(scopes).toContain(scope);
  });
});

describe("#2631 the app requests no returns access (owner, 2026-10-23)", () => {
  it("no read_returns / write_returns in [access_scopes] or .env.example, and no returnCreate in the app", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const scopes = tomlValue(tomlSection("access_scopes"), "scopes");
    expect(scopes).not.toMatch(/returns/);
    expect(readFileSync(".env.example", "utf8")).not.toMatch(/_returns/);
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk("app")) expect(readFileSync(f, "utf8"), f).not.toMatch(/returnCreate\b/);
  });
});

describe("G2 — no theme scope: the embed state comes from App Bridge app.extensions()", () => {
  it("requests neither read_themes nor write_themes, and no app code reads a theme", () => {
    const scopes = tomlValue(tomlSection("access_scopes"), "scopes");
    expect(scopes).not.toMatch(/_themes/);
    expect(readFileSync(".env.example", "utf8")).not.toMatch(/_themes/);
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk("app")) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bthemes\s*\(|settings_data\.json|OnlineStoreThemeFile/);
  });
});

/** A TOML string array (`key = [ "a", "b" ]`, one or many lines) inside a section. */
function tomlArray(section: string, key: string): string[] {
  const m = section.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!m) throw new Error(`${key} missing`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/**
 * Audit item 2 (2026-11-26): from 2026-12-01 Shopify rejects deploys/submissions of an
 * app with a theme app extension or app proxy whose shopify.app.toml has no
 * `[network_access] allowed_sources`. The list must name every external server the
 * storefront page contacts (the widget's platform origin), in Shopify's format.
 * https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration (network_access)
 */
describe("shopify.app.toml [network_access]", () => {
  const section = tomlSection("network_access");
  const sources = tomlArray(section, "allowed_sources");
  const nav = tomlArray(section, "allowed_navigation_hosts");
  const liquid = readFileSync(join(root, "extensions/storefront-assistant/blocks/assistant.liquid"), "utf8");
  const widgetOrigins = [
    liquid.match(/data-origin="([^"]+)"/)![1],
    assistantJs.match(/getAttribute\("data-origin"\)\s*\|\|\s*"([^"]+)"/)![1],
  ];

  it("allowed_sources covers the origin the theme embed loads the widget from", () => {
    for (const origin of widgetOrigins) expect(sources).toContain(new URL(origin).origin);
  });

  it("every source is a lowercase HTTPS origin: no path, trailing slash, :443, IP, localhost or Shopify domain", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.length).toBeLessThanOrEqual(20); // the changelog says 20, the reference 30: keep the stricter
    for (const s of sources) {
      expect(s).toBe(s.toLowerCase());
      expect(s).toMatch(/^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/);
      expect(s).not.toMatch(/:443$/);
      expect(s).not.toMatch(/localhost|^https:\/\/[\d.]+$|myshopify\.com|shopify(cdn)?\.com/);
    }
  });

  it("allowed_navigation_hosts names the fallback link's host as a bare lowercase host", () => {
    expect(assistantJs).toMatch(/link\.href = origin \+ "\/chat\/w\/"/);
    for (const origin of widgetOrigins) expect(nav).toContain(new URL(origin).hostname);
    for (const h of nav) expect(h).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });
});

/** Audit L3 (2026-11-26): every declared OAuth redirect URL must be a path this app serves. */
describe("shopify.app.toml [auth] redirect_urls", () => {
  it("each one is <application_url><authPathPrefix>/… (app/routes/auth.$.tsx), none 404s", () => {
    const appUrl = toml.match(/^application_url\s*=\s*"([^"]+)"/m)![1];
    const server = readFileSync(join(root, "app/shopify.server.ts"), "utf8");
    const prefix = server.match(/authPathPrefix:\s*"([^"]+)"/)![1];
    expect(existsSync(join(root, "app/routes/auth.$.tsx"))).toBe(true);
    const urls = tomlArray(tomlSection("auth"), "redirect_urls");
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith(`${appUrl}${prefix}/`), u).toBe(true);
  });
});
