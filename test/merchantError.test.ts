import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { merchantError, merchantMessage, SUPPORT_EMAIL } from "../app/lib/merchantError";

// busymate-ai-src#2618 — the App Store reviewer read this raw refusal in a toast (Req 2.1.1).
const REVIEWER_TOAST =
  "set_tenant_branding refused: native_action_denied (denied) — proof-of-shop, or a tenant-admin of this tenant (or a platform operator), is required to edit its branding";

describe("merchantMessage (#2618: no machinery in a merchant toast)", () => {
  it("RED→GREEN: the reviewer's raw refusal becomes one plain sentence with a next step", () => {
    const m = merchantMessage("branding", REVIEWER_TOAST);
    expect(m).not.toMatch(/set_tenant_branding|native_action|refused|denied|tenant|proof/i);
    expect(m).toMatch(/couldn't save your assistant settings/);
    expect(m).toContain(SUPPORT_EMAIL);
  });

  it.each([
    ["retrain", "publish_tenant_runtime refused: preflight_failed"],
    ["reprovision", "fetch failed"],
    ["billing", "GraphQL 502 from Admin API"],
    ["branding", "TypeError: Cannot read properties of undefined"],
    ["branding", ""],
    ["branding", null],
  ] as const)("%s: %j is replaced by the plain sentence", (action, raw) => {
    const m = merchantMessage(action, raw);
    expect(m).not.toBe(raw);
    expect(m).not.toMatch(/_|refused|fetch failed|GraphQL|TypeError|undefined/);
  });

  it("our own merchant-facing validation copy passes through unchanged", () => {
    expect(merchantMessage("branding", "Both names are required.")).toBe("Both names are required.");
  });

  it("logs the raw cause server-side when it hides it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    merchantError("branding", "x.myshopify.com", REVIEWER_TOAST);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("native_action_denied"));
    warn.mockRestore();
  });

  it("every embedded save path maps its error through merchantError (settings, connector, billing)", () => {
    for (const [route, action] of [["app.settings", "branding"], ["app.connector", "retrain"], ["app.connector", "reprovision"], ["app.billing", "billing"]]) {
      const src = readFileSync(`app/routes/${route}.tsx`, "utf8");
      expect(src, route).toContain(`merchantError("${action}"`);
      expect(src, route).not.toMatch(/Re-train failed: \$\{|Still not live: \$\{|Could not verify with Shopify: \$\{/);
    }
  });
});
