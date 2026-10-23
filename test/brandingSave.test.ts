import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { saveBrandingAndRepublish, validateBranding } from "../app/lib/brandingSave";
import { merchantMessage } from "../app/lib/merchantError";

// #2132 FAIL C — Assistant settings → rename → the storefront widget still
// greeted "Hi, I'm bro" after a full reload: `set_tenant_branding` updates the
// tenant ROW, but the widget renders the PUBLISHED revision (brand synthesized
// from the row at publish time), and the save never re-published.

const shop = "acme.myshopify.com";
const names = { productName: "Acme Boards", assistantName: "Riley Helper" };

function deps(over: Partial<{ set: { ok: boolean; error?: string }; pub: { ok: boolean; error?: string; revision?: number } }> = {}) {
  const order: string[] = [];
  const setBranding = vi.fn(async () => {
    order.push("set_tenant_branding");
    return over.set ?? { ok: true };
  });
  const republish = vi.fn(async () => {
    order.push("publish_tenant_runtime");
    return over.pub ?? { ok: true, revision: 7 };
  });
  return { setBranding, republish, order };
}

describe("assistant settings save (#2132 C)", () => {
  it("RED→GREEN: a branding save RE-PUBLISHES the runtime after set_tenant_branding (row → published revision)", async () => {
    const d = deps();
    const out = await saveBrandingAndRepublish(shop, "t_1", names, d);
    expect(out).toEqual({ ok: true, error: null, published: true, revision: 7 });
    expect(d.order).toEqual(["set_tenant_branding", "publish_tenant_runtime"]);
    expect(d.setBranding).toHaveBeenCalledWith(shop, "t_1", names);
    expect(d.republish).toHaveBeenCalledWith(shop);
  });

  it("the settings ROUTE saves through this seam (never a bare set_tenant_branding)", () => {
    const src = readFileSync(new URL("../app/routes/app.settings.tsx", import.meta.url), "utf8");
    expect(src).toContain("saveBrandingAndRepublish(");
    expect(src).toContain("republish: (shop) => retrainForMerchant(shop)");
  });

  it("FAIL-CLOSED: a failed publish is reported as saved-but-not-live (no green toast over a stale widget)", async () => {
    const d = deps({ pub: { ok: false, error: "preflight failed" } });
    const out = await saveBrandingAndRepublish(shop, "t_1", names, d);
    expect(out.ok).toBe(false);
    expect(out.published).toBe(false);
    expect(out.error).toMatch(/storefront assistant couldn't be updated/);
    // #2618 — the raw publish cause is logged, never shown to the merchant.
    expect(out.error).not.toMatch(/preflight failed/);
    expect(merchantMessage("branding", out.error)).toBe(out.error);
  });

  it("a refused set_tenant_branding never publishes (nothing to publish)", async () => {
    const d = deps({ set: { ok: false, error: "tenant-admin required" } });
    const out = await saveBrandingAndRepublish(shop, "t_1", names, d);
    expect(out).toMatchObject({ ok: false, error: "tenant-admin required", published: false });
    expect(d.republish).not.toHaveBeenCalled();
  });

  it("no provisioned tenant ⇒ refused before any MCP call", async () => {
    const d = deps();
    const out = await saveBrandingAndRepublish(shop, null, names, d);
    expect(out.ok).toBe(false);
    expect(d.setBranding).not.toHaveBeenCalled();
    expect(d.republish).not.toHaveBeenCalled();
  });

  it("validates the names (required, 40/80 max) and trims them before the write", async () => {
    expect(validateBranding({ assistantName: "", productName: "x" })).toMatch(/required/);
    expect(validateBranding({ assistantName: "a".repeat(41), productName: "x" })).toMatch(/too long/);
    expect(validateBranding({ assistantName: "bro", productName: "x".repeat(81) })).toMatch(/too long/);
    expect(validateBranding(names)).toBeNull();
    const d = deps();
    await saveBrandingAndRepublish(shop, "t_1", { productName: "  Acme  ", assistantName: " Riley " }, d);
    expect(d.setBranding).toHaveBeenCalledWith(shop, "t_1", { productName: "Acme", assistantName: "Riley" });
  });
});
