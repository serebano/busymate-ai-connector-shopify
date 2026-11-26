// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Accessibility of the embedded admin (reviewer checklist G5, axe): every page
 * has a document title, ONE main landmark and a level-one heading; an unknown
 * /app path stays in the app (inventory F10).
 */
const h = vi.hoisted(() => ({ pathname: "/app/conversations", search: "", error: null as unknown }));
vi.mock("react-router", async () => ({
  ...(await vi.importActual("react-router")),
  useLoaderData: () => ({ apiKey: "k", navigation: { shop: "acme.myshopify.com", host: "aG9zdA==" } }),
  useRouteLoaderData: () => ({ apiKey: "k" }),
  useLocation: () => ({ pathname: h.pathname, search: h.search }),
  useRouteError: () => h.error,
  useNavigation: () => ({ state: "idle" }),
  Outlet: () => createElement("div", { "data-outlet": "" }),
  Link: ({ to, children }: { to: string; children?: ReactNode }) => createElement("a", { href: to }, children),
  Meta: () => null, Links: () => null, Scripts: () => null, ScrollRestoration: () => null,
}));
vi.mock("@shopify/app-bridge-react", () => ({
  NavMenu: ({ children }: { children?: ReactNode }) => createElement("ui-nav-menu", null, children),
  TitleBar: ({ title }: { title: string }) => createElement("ui-title-bar", { title }),
  useAppBridge: () => ({ loading: vi.fn() }),
}));
vi.mock("@shopify/shopify-app-react-router/react", () => ({ AppProvider: ({ children }: { children?: ReactNode }) => children }));
vi.mock("@shopify/shopify-app-react-router/server", () => ({ boundary: { error: vi.fn(), headers: vi.fn() } }));
vi.mock("@shopify/polaris/build/esm/styles.css?url", () => ({ default: "/polaris.css" }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn(async () => ({ session: { shop: "acme.myshopify.com" } })) } }));

import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { adminDocumentTitle, adminPageTitle, NOT_FOUND_TITLE } from "../app/lib/adminPageTitle";
import { embeddedHomeFromSearch } from "../app/lib/embeddedNavigation";
import * as layout from "../app/routes/app";
import * as notFound from "../app/routes/app.$";
import * as root from "../app/root";

const routesDir = join(__dirname, "..", "app", "routes");
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("admin page titles", () => {
  it("names every route and falls back to Page not found", () => {
    expect(adminPageTitle("/app")).toBe("Busymate AI");
    expect(adminDocumentTitle("/app")).toBe("Busymate AI");
    expect(adminDocumentTitle("/app/conversations")).toBe("Conversations · Busymate AI");
    expect(adminPageTitle("/app/conversations/transcripts/abc")).toBe("Conversation history");
    expect(adminPageTitle("/app/conversations/handoffs/abc")).toBe("Customer conversation");
    expect(adminPageTitle("/app/nope")).toBe(NOT_FOUND_TITLE);
  });

  it("matches the TitleBar title of every app route file", () => {
    const paths: Record<string, string> = {
      "app._index.tsx": "/app", "app.billing.tsx": "/app/billing", "app.connector.tsx": "/app/connector",
      "app.conversations.tsx": "/app/conversations", "app.settings.tsx": "/app/settings",
      "app.conversations_.transcripts.$sessionId.tsx": "/app/conversations/transcripts/x",
      "app.conversations_.handoffs.$requestId.tsx": "/app/conversations/handoffs/x",
    };
    const withTitleBar = readdirSync(routesDir).filter((f) => /^app\..+\.tsx$/.test(f) && /TitleBar\s+title="/.test(readFileSync(join(routesDir, f), "utf8")));
    expect(withTitleBar.sort()).toEqual(Object.keys(paths).sort());
    for (const [file, path] of Object.entries(paths)) {
      const title = /TitleBar\s+title="([^"]+)"/.exec(readFileSync(join(routesDir, file), "utf8"))![1];
      expect(adminPageTitle(path), file).toBe(title);
    }
  });

  it("no child route overrides the layout's meta", () => {
    for (const f of readdirSync(routesDir).filter((f) => /^app\..+\.tsx$/.test(f))) {
      expect(readFileSync(join(routesDir, f), "utf8"), f).not.toMatch(/export const meta\b/);
    }
  });
});

describe("admin layout", () => {
  it("meta gives the document a title for the current path", () => {
    const meta = layout.meta as unknown as (args: { location: { pathname: string } }) => { title: string }[];
    expect(meta({ location: { pathname: "/app/billing" } })).toEqual([{ title: "Billing · Busymate AI" }]);
  });

  it("renders one main landmark with one h1 that names the page, around the routed page", () => {
    h.pathname = "/app/settings";
    const html = renderToStaticMarkup(createElement(layout.default));
    expect(count(html, /<main\b/g)).toBe(1);
    expect(count(html, /<h1\b/g)).toBe(1);
    expect(html).toMatch(/<main><h1 class="[^"]*Polaris-Text--visuallyHidden[^"]*">Assistant settings<\/h1><div data-outlet/);
  });

  it("the layout's own error view keeps a main landmark and a heading", () => {
    h.error = new Error("boom");
    const html = renderToStaticMarkup(createElement(layout.ErrorBoundary));
    expect(count(html, /<main\b/g)).toBe(1);
    expect(html).toMatch(/<h1 [^>]*>Something went wrong<\/h1>/);
  });
});

describe("unknown /app path (F10)", () => {
  it("is a 404 that renders inside the app with a way back to Home", async () => {
    const res = (await notFound.loader({ request: new Request("https://store.busymate.ai/app/nope"), params: {}, context: {} } as never)) as unknown as { init: { status: number } };
    expect(res.init.status).toBe(404);
    const html = renderToStaticMarkup(createElement(AppProvider, { i18n: en }, createElement(notFound.default)));
    expect(html).toContain(`title="${NOT_FOUND_TITLE}"`);
    expect(html).toContain("Back to Home");
    expect(html).toMatch(/href="\/app"/);
    expect(html).not.toContain("busymate.ai");
  });

  it("the root error page links to the embedded Home inside /app and to the site elsewhere", () => {
    h.error = { status: 404, statusText: "Not Found", internal: true, data: "" };
    h.pathname = "/app/handoffs/x"; h.search = "?shop=acme.myshopify.com&host=aG9zdA%3D%3D&embedded=1&id_token=stale";
    let html = renderToStaticMarkup(createElement(root.ErrorBoundary));
    expect(html).toContain('href="/app?shop=acme.myshopify.com&amp;host=aG9zdA%3D%3D&amp;embedded=1"');
    expect(html).not.toContain("https://busymate.ai");
    expect(html).not.toContain("id_token");
    h.search = "?shop=evil.example.com&host=x";
    html = renderToStaticMarkup(createElement(root.ErrorBoundary));
    expect(html).not.toMatch(/<a\b/);
    h.pathname = "/legal/nope"; h.search = "";
    html = renderToStaticMarkup(createElement(root.ErrorBoundary));
    expect(html).toContain('href="https://busymate.ai"');
    expect(count(html, /<main\b/g)).toBe(1);
    expect(count(html, /<h1\b/g)).toBe(1);
  });

  it("embeddedHomeFromSearch refuses a query that does not name a shop", () => {
    expect(embeddedHomeFromSearch("")).toBeNull();
    expect(embeddedHomeFromSearch("?shop=a.myshopify.com.evil.com&host=aaa")).toBeNull();
    expect(embeddedHomeFromSearch("?shop=a.myshopify.com&host=%3Cscript%3E")).toBeNull();
  });

  it("the root error page's link colours meet 4.5:1 on its background", () => {
    const css = readFileSync(join(__dirname, "..", "app", "root.tsx"), "utf8");
    const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
    const sets = [...css.matchAll(/--bm-bg:(#[0-9a-f]{6}).*?--bm-muted:(#[0-9a-f]{6});(?: --bm-accent:(#[0-9a-f]{6});)?/g)];
    expect(sets).toHaveLength(2);
    for (const [, bg, muted, accent] of sets) {
      expect(ratio(muted!, bg!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(accent!, bg!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
