/**
 * Red-team F5 (2026-11-26): the Dev Dashboard showed admin CLS 0.36 and App Bridge
 * loaded twice on Home. Two root causes, both pinned here:
 *  1. app.tsx used the SDK's `AppProvider`, which renders a SECOND app-bridge.js and
 *     the unused polaris.js web-components bundle (149 KB br) as parser-blocking
 *     scripts in <body>. App Bridge now loads once, first in <head> (root.tsx).
 *  2. Home's embed card + checklist rendered "Checking your theme" first and
 *     changed height when App Bridge answered. Home now renders the last known
 *     answer, and reports a changed one back.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastKnownEmbed, parseEmbedStatus } from "../app/lib/themeEmbed";
import { shouldReportEmbed } from "../app/lib/useAppEmbedStatus";

const appDir = join(__dirname, "..", "app");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const sources = walk(appDir).filter((f) => /\.(tsx?|jsx?)$/.test(f));

describe("App Bridge loads exactly once", () => {
  it("root.tsx has the one app-bridge.js tag, in <head> before any other script", () => {
    const root = readFileSync(join(appDir, "root.tsx"), "utf8");
    expect(root.match(/shopifycloud\/app-bridge\.js/g)).toHaveLength(1);
    const head = root.slice(root.indexOf("<head>"), root.indexOf("</head>"));
    expect(head).toContain("shopifycloud/app-bridge.js");
    expect(head.indexOf("app-bridge.js")).toBeLessThan(head.search(/<(Meta|Links|script)\b(?![^>]*app-bridge)/));
  });
  it("no module uses the SDK AppProvider (second app-bridge.js + polaris.js)", () => {
    for (const f of sources) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from "@shopify\/shopify-app-react-router\/react"/);
      if (!f.endsWith("root.tsx")) expect(src, f).not.toMatch(/shopifycloud\/app-bridge\.js/);
      expect(src, f).not.toMatch(/shopifycloud\/polaris\.js/);
    }
  });
  it("the admin layout still routes admin nav clicks (shopify:navigate)", () => {
    const layout = readFileSync(join(appDir, "routes", "app.tsx"), "utf8");
    expect(layout).toMatch(/<AppBridgeNavigation \/>/);
    const nav = readFileSync(join(appDir, "components", "AppBridgeNavigation.tsx"), "utf8");
    expect(nav).toMatch(/addEventListener\("shopify:navigate"/);
  });
});

describe("Home embed state renders in its final shape (no shift)", () => {
  it("starts from the stored answer, never the 'checking' placeholder", () => {
    expect(lastKnownEmbed(new Date())).toBe("on");
    expect(lastKnownEmbed("2026-11-26T10:00:00Z")).toBe("on");
    expect(lastKnownEmbed(null)).toBe("off");
    expect(lastKnownEmbed(undefined)).toBe("off");
  });
  it("reports only a definite answer that differs from the stored one", () => {
    expect(shouldReportEmbed("on", "off")).toBe(true);
    expect(shouldReportEmbed("off", "on")).toBe(true);
    expect(shouldReportEmbed("on", "on")).toBe(false);
    expect(shouldReportEmbed("unknown", "on")).toBe(false);
    expect(shouldReportEmbed("checking", "off")).toBe(false);
  });
  it("the report endpoint refuses anything but on/off (no write)", () => {
    expect(parseEmbedStatus({ status: "on" })).toBe("on");
    expect(parseEmbedStatus({ status: "off" })).toBe("off");
    for (const bad of [null, undefined, "on", {}, { status: "ON" }, { status: true }, { status: "unknown" }])
      expect(parseEmbedStatus(bad)).toBeNull();
  });
  it("the report endpoint takes the shop from the session, never the body", () => {
    const route = readFileSync(join(appDir, "routes", "api.embed-status.tsx"), "utf8");
    expect(route).toMatch(/authenticate\.admin\(request\)/);
    expect(route).toMatch(/where: \{ shop: session\.shop \}/);
  });
});
