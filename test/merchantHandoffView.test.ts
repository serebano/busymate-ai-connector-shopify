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
