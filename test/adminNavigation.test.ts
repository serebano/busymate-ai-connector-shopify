// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import translations from "@shopify/polaris/locales/en.json";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Built for Shopify 4.1.1 (a sub-page has a back button to its parent) and 4.1.4
 * (a sub-page keeps its parent nav item highlighted), reviewer checklist A7, plus
 * the admin loading bar and the card empty state.
 */
const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigation: { state: "idle" as string },
  loading: vi.fn(),
  redirect: vi.fn((url: string) => new Response(null, { status: 302, headers: { Location: url } })),
  conversations: {
    provisioned: true, servingHost: null,
    handoffs: { ok: true, rows: [] as unknown[] },
    conversations: { ok: true, rows: [] as unknown[] },
  },
}));
vi.mock("react-router", async () => ({
  ...(await vi.importActual("react-router")),
  useNavigate: () => h.navigate,
  useNavigation: () => h.navigation,
  useLoaderData: () => h.conversations,
}));
vi.mock("@shopify/app-bridge-react", () => ({
  TitleBar: ({ title, children }: { title: string; children?: ReactNode }) => createElement("ui-title-bar", { title }, children),
  useAppBridge: () => ({ loading: h.loading }),
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ redirect: h.redirect, session: { shop: "acme.myshopify.com" } })) },
}));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/bmai.server", () => ({ callMcpTool: vi.fn(), storefrontPublicForShop: vi.fn() }));
import { ConversationTitleBar } from "../app/components/ConversationTitleBar";
import { EmbeddedNavigationContext } from "../app/components/EmbeddedNavigation";
import { AdminLoadingBar } from "../app/components/AdminLoadingBar";
import { embeddedNavigationForShop } from "../app/lib/embeddedNavigation";
import Conversations from "../app/routes/app.conversations";
import * as oldHandoff from "../app/routes/app.handoffs.$requestId";
import * as oldTranscript from "../app/routes/app.transcripts.$sessionId";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const route = (file: string) => join(__dirname, "..", "app", "routes", file);
const nav = embeddedNavigationForShop("acme.myshopify.com");

beforeEach(() => {
  h.navigate.mockClear();
  h.loading.mockClear();
  h.redirect.mockClear();
  h.navigation = { state: "idle" };
});

describe("pages under Conversations", () => {
  it("live under /app/conversations/… and outside the list page's layout", () => {
    // `conversations_` (trailing underscore): the URL nests, the list page does not wrap it.
    expect(existsSync(route("app.conversations_.handoffs.$requestId.tsx"))).toBe(true);
    expect(existsSync(route("app.conversations_.transcripts.$sessionId.tsx"))).toBe(true);
  });

  it("the list links to the nested addresses", () => {
    const src = readFileSync(route("app.conversations.tsx"), "utf8");
    expect(src).toContain("`/app/conversations/handoffs/${");
    expect(src).toContain("`/app/conversations/transcripts/${");
    expect(src).not.toMatch(/`\/app\/(handoffs|transcripts)\//);
  });

  it.each([
    ["app.conversations_.handoffs.$requestId.tsx", "Customer conversation"],
    ["app.conversations_.transcripts.$sessionId.tsx", "Conversation history"],
  ])("%s uses the title bar with the back action and has no in-page back link", (file, title) => {
    const src = readFileSync(route(file), "utf8");
    expect(src).toContain(`<ConversationTitleBar title="${title}"`);
    expect(src).not.toContain("Back to Conversations");
  });

  it("the title bar has a breadcrumb back action to Conversations and a Refresh action", () => {
    const html = renderToStaticMarkup(
      createElement(EmbeddedNavigationContext.Provider, { value: nav }, createElement(ConversationTitleBar, { title: "Conversation history", onRefresh: () => {}, refreshing: false })),
    );
    expect(html).toContain('<ui-title-bar title="Conversation history">');
    expect(html).toContain('<button variant="breadcrumb">Conversations</button>');
    expect(html).toContain("<button>Refresh</button>");
  });

  it("the back action goes to the parent page client-side, keeping the embedded context", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const onRefresh = vi.fn();
    await act(() => root.render(createElement(EmbeddedNavigationContext.Provider, { value: nav }, createElement(ConversationTitleBar, { title: "t", onRefresh, refreshing: false }))));
    await act(() => host.querySelector<HTMLButtonElement>('button[variant="breadcrumb"]')!.click());
    expect(h.navigate).toHaveBeenCalledWith(`/app/conversations?shop=acme.myshopify.com&host=${encodeURIComponent(nav.host)}&embedded=1`);
    await act(() => host.querySelector<HTMLButtonElement>("button:not([variant])")!.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
  });

  it("Refresh shows loading and cannot be pressed twice while it runs", () => {
    const html = renderToStaticMarkup(createElement(ConversationTitleBar, { title: "t", onRefresh: () => {}, refreshing: true }));
    expect(html).toContain('<button disabled="" loading="">Refresh</button>');
  });

  it.each([
    ["handoff", oldHandoff.loader, { requestId: "20000000-0000-4000-8000-000000000002" }, "/app/conversations/handoffs/20000000-0000-4000-8000-000000000002"],
    ["transcript", oldTranscript.loader, { sessionId: "wrun_01TEST" }, "/app/conversations/transcripts/wrun_01TEST"],
  ])("the old %s address redirects to the nested one, without the old link's token", async (_name, loader, params, path) => {
    const request = new Request("https://store.busymate.ai/app/old?shop=evil.myshopify.com&id_token=stale&embedded=1");
    await expect((loader as (a: unknown) => Promise<unknown>)({ request, params, context: {} })).rejects.toBeInstanceOf(Response);
    const target = h.redirect.mock.calls[0][0];
    expect(target.startsWith(`${path}?`)).toBe(true);
    expect(target).toContain("shop=acme.myshopify.com");
    expect(target).not.toContain("id_token");
    expect(target).not.toContain("evil");
  });
});

describe("admin loading bar", () => {
  it("is on while a page of the app loads and off when it has loaded", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(() => root.render(createElement(AdminLoadingBar)));
    expect(h.loading).toHaveBeenLastCalledWith(false);
    h.navigation = { state: "loading" };
    await act(() => root.render(createElement(AdminLoadingBar)));
    expect(h.loading).toHaveBeenLastCalledWith(true);
    h.navigation = { state: "idle" };
    await act(() => root.render(createElement(AdminLoadingBar)));
    expect(h.loading).toHaveBeenLastCalledWith(false);
    expect(host.innerHTML).toBe("");
    await act(() => root.unmount());
  });

  it("the app layout mounts it once, for every page", () => {
    const src = readFileSync(route("app.tsx"), "utf8");
    expect(src.match(/<AdminLoadingBar \/>/g)).toHaveLength(1);
  });
});

describe("empty states", () => {
  it("Conversations with nothing yet explains both cards and loads no image", () => {
    const html = renderToStaticMarkup(createElement(AppProvider, { i18n: translations, children: createElement(Conversations) }));
    expect(html).toContain("No shopper is waiting for a person");
    expect(html).toContain("No conversations yet");
    expect(html).not.toContain("<img");
  });
});
