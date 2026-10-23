import { describe, expect, it } from "vitest";
import { TOOLS, publicToolNames, toolByName } from "../app/mcp/tools/registry";

// Enforce the access-tier invariants that map onto mcp_connector_support_policies.
// A regression here is a security regression (a write reaching the free-text path).
describe("connector tool registry gates", () => {
  it("every WRITE (delegated) tool is confirm-gated", () => {
    for (const t of TOOLS) {
      if (t.tier === "delegated") expect(t.confirm, `${t.name} must confirm`).toBe(true);
    }
  });

  it("the highest-risk writes (refund/cancel) are adminOnly", () => {
    for (const name of ["create_refund", "cancel_order"]) {
      expect(toolByName(name)?.adminOnly, `${name} must be adminOnly`).toBe(true);
    }
  });

  it("#2631 no returns tool (the app requests no returns scope)", () => {
    expect(toolByName("start_return")).toBeUndefined();
  });

  it("public tools never write and never confirm", () => {
    for (const t of TOOLS.filter((x) => x.tier === "public")) {
      expect(t.confirm).toBe(false);
      expect(t.adminOnly).toBe(false);
    }
  });

  it("only public tools are exposed pre-auth for discovery", () => {
    const names = publicToolNames();
    expect(names).toContain("search_products");
    expect(names).not.toContain("create_refund");
  });

  it("identified reads are not adminOnly but require a customer subject at runtime", () => {
    expect(toolByName("get_order_status")?.tier).toBe("identified");
    expect(toolByName("get_order_status")?.adminOnly).toBe(false);
  });
});
