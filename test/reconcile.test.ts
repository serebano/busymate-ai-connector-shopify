import { describe, expect, it } from "vitest";
import { planReconcile, type ReconcileRow } from "../app/lib/reconcile";

/**
 * #3718 — the reconcile sweep repairs the rows that say `published` while the
 * storefront chat cannot open (orphaned tenant, stuck revision, refused chain),
 * and never touches an uninstalled shop.
 */
const row = (over: Partial<ReconcileRow> = {}): ReconcileRow => ({
  shop: "demo.myshopify.com",
  provisionState: "published",
  bmaiTenantId: "t-1",
  tenantUnreachableAt: null,
  ...over,
});
const ready = { state: "ready" as const, detail: "" };

describe("planReconcile (#3718)", () => {
  it("a live, frameable tenant is left alone", () => {
    expect(planReconcile(row(), { readiness: ready, frameable: true })).toMatchObject({ verdict: "live", action: "none" });
    expect(planReconcile(row(), { readiness: ready, frameable: null })).toMatchObject({ verdict: "live", action: "none" });
  });

  it("an ORPHANED tenant (the demo store) is re-provisioned", () => {
    expect(planReconcile(row({ tenantUnreachableAt: new Date() }), { readiness: null, frameable: false })).toMatchObject({ verdict: "orphaned", action: "reprovision" });
  });

  // #3718 review defect 2 — the demo store: the platform answers that the tenant
  // is gone. No meter flag, no --reprovision-unverified: it is repaired.
  it("an ORPHANED tenant read from the platform's own answer is re-provisioned WITHOUT a flag", () => {
    const orphaned = { state: "orphaned" as const, detail: "" };
    expect(planReconcile(row(), { readiness: orphaned, frameable: null })).toMatchObject({ verdict: "orphaned", action: "reprovision" });
    expect(planReconcile(row(), { readiness: orphaned, frameable: true })).toMatchObject({ verdict: "orphaned", action: "reprovision" });
  });

  // #3718 review defect 3 — a custom domain connected after install (or any row
  // provisioned before 0.1.12) is missing from the published allowlist.
  it("a storefront domain missing from the published allowlist is re-provisioned", () => {
    const plan = planReconcile(row({ customDomain: null }), { readiness: ready, frameable: true, freshHosts: ["www.brand.example"] });
    expect(plan).toMatchObject({ verdict: "domains-missing", action: "reprovision" });
    expect(plan.reason).toContain("www.brand.example");
  });

  it("stored domains that cover the fresh read are live; an unreadable domain read is never a repair", () => {
    expect(planReconcile(row({ customDomain: "www.brand.example,brand.example" }), { readiness: ready, frameable: true, freshHosts: ["brand.example", "www.brand.example"] }))
      .toMatchObject({ verdict: "live", action: "none" });
    expect(planReconcile(row({ customDomain: null }), { readiness: ready, frameable: true, freshHosts: null }))
      .toMatchObject({ verdict: "live", action: "none" });
  });

  it("a STUCK revision (the reinstall deadlock) is re-provisioned", () => {
    expect(planReconcile(row(), { readiness: { state: "error", detail: "" }, frameable: false })).toMatchObject({ verdict: "stuck", action: "reprovision" });
  });

  it("live but refused in the storefront or Theme Editor chain is re-provisioned", () => {
    expect(planReconcile(row(), { readiness: ready, frameable: false })).toMatchObject({ verdict: "not-frameable", action: "reprovision" });
  });

  it("an activating revision is left to finish", () => {
    expect(planReconcile(row(), { readiness: { state: "pending", detail: "" }, frameable: false })).toMatchObject({ verdict: "activating", action: "none" });
  });

  it("an unreadable tenant is reported, and re-provisioned only when asked", () => {
    const reads = { readiness: { state: "unverified" as const, detail: "" }, frameable: null };
    expect(planReconcile(row(), reads)).toMatchObject({ verdict: "unverified", action: "none" });
    expect(planReconcile(row(), reads, { reprovisionUnverified: true })).toMatchObject({ verdict: "unverified", action: "reprovision" });
  });

  it("an inactive (deleted-on-Shopify) shop is NEVER touched, whatever the reads say (#52)", () => {
    expect(planReconcile(row({ inactiveAt: new Date(), tenantUnreachableAt: new Date() }), { readiness: { state: "error", detail: "" }, frameable: false })).toMatchObject({ verdict: "inactive", action: "none" });
  });

  it("an uninstalled shop is NEVER touched, whatever the reads say", () => {
    expect(planReconcile(row({ provisionState: "suspended", tenantUnreachableAt: new Date() }), { readiness: { state: "error", detail: "" }, frameable: false })).toMatchObject({ verdict: "uninstalled", action: "none" });
  });

  it("a failed install is retried; a never-published row is not", () => {
    expect(planReconcile(row({ provisionState: "error" }), { readiness: null, frameable: null })).toMatchObject({ action: "reprovision" });
    expect(planReconcile(row({ provisionState: "pending", bmaiTenantId: null }), { readiness: null, frameable: null })).toMatchObject({ verdict: "not-published", action: "none" });
  });
});
