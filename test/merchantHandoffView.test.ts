import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import translations from "@shopify/polaris/locales/en.json";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  provisioned: true, servingHost: null,
  handoffs: { ok: true, rows: [{ id: "20000000-0000-4000-8000-000000000002", sessionId: "wrun_01TEST", supportSessionId: null, status: "resolved", reason: "Help with my order", requestedAt: "2026-10-08T12:00:00Z" }] },
  conversations: { ok: true, rows: [] },
}));
vi.mock("react-router", async () => ({ ...await vi.importActual("react-router"), useLoaderData: () => state }));
vi.mock("@shopify/app-bridge-react", () => ({ TitleBar: () => null }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/bmai.server", () => ({ callMcpTool: vi.fn() }));
import Conversations from "../app/routes/app.conversations";

describe("completed handoff navigation", () => {
  it("keeps the merchant's human transcript reachable after resolving", () => {
    const html = renderToStaticMarkup(createElement(AppProvider, { i18n: translations, children: createElement(Conversations) }));
    expect(html).toContain("Recent completed handoffs");
    expect(html).toContain("/app/handoffs/20000000-0000-4000-8000-000000000002");
    expect(html).toContain("Help with my order");
    expect(html).toContain("0 open");
    expect(html).not.toContain("https://busymate.ai/console/inbox");
  });
});

// Review re-check 2026-10-26 (1600 px admin): IndexTable cells never wrap, so a long open-handoff
// reason (shopper note + reply email) pushed "Open conversation" behind a horizontal scrollbar.
describe("open handoff row keeps its action in view", () => {
  it("wraps the reason (max three lines) instead of widening the table", () => {
    const long = "Round 8 check: handoff only in this chat. Reply email: mr.serebano+bmir3r8@gmail.com and more words to make it long";
    state.handoffs = { ok: true, rows: [{ id: "20000000-0000-4000-8000-000000000003", sessionId: "wrun_01OPEN", supportSessionId: null, status: "requested", reason: long, requestedAt: "2026-10-26T09:47:26Z" }] };
    const html = renderToStaticMarkup(createElement(AppProvider, { i18n: translations, children: createElement(Conversations) }));
    const cell = html.slice(html.indexOf(`title="${long}"`) - 5, html.indexOf(long, html.indexOf(`title="${long}"`) + long.length + 10) + long.length);
    expect(cell).toContain("white-space:normal");
    expect(cell).toContain("overflow-wrap:anywhere");
    expect(cell).toContain("-webkit-line-clamp:3");
    expect(html).toContain("/app/handoffs/20000000-0000-4000-8000-000000000003");
  });
});
