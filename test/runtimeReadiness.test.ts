import { describe, expect, it, vi } from "vitest";
import { isOrphanError, runtimeReadiness, readRuntimeReadiness } from "../app/lib/runtimeReadiness";

const ready = () => ({ ok: true, data: {
  ok: true, tenant: { id: "tenant", status: "active" }, publication: { revision: { revision: 3, status: "published" } },
  runtime: { desired_revision: 3, applied_revision: 3, state: "ready" },
} });

describe("published runtime evidence", () => {
  it("requires matching positive publication and projection evidence", () => {
    expect(runtimeReadiness("tenant", ready()).state).toBe("ready");
  });
  it.each(["pending", "error"])("does not treat %s as live", state => {
    const result = ready(); result.data.runtime.state = state;
    expect(runtimeReadiness("tenant", result).state).toBe(state);
  });
  it.each(["applied_revision", "desired_revision"] as const)("rejects stale %s", field => {
    const result = ready(); result.data.runtime[field] = 2;
    expect(runtimeReadiness("tenant", result).state).toBe("unverified");
  });
  it("rejects another tenant and denied or empty observations", () => {
    expect(runtimeReadiness("other", ready()).state).toBe("unverified");
    expect(runtimeReadiness("tenant", { ok: false, error: "denied" }).state).toBe("unverified");
    expect(runtimeReadiness("tenant", { ok: true }).state).toBe("unverified");
  });
  it("cannot call a zero revision live", () => {
    const result = ready(); result.data.publication.revision.revision = 0;
    result.data.runtime.applied_revision = 0; result.data.runtime.desired_revision = 0;
    expect(runtimeReadiness("tenant", result).state).toBe("unverified");
  });
  it("rejects archived tenants even before projection catches up", () => {
    const result = ready(); result.data.tenant.status = "archived";
    expect(runtimeReadiness("tenant", result).state).toBe("unverified");
  });
  it("distinguishes missing runtime evidence from real pending work", () => {
    const result = ready();
    expect(runtimeReadiness("tenant", { ...result, data: { ...result.data, runtime: null } }).state).toBe("unverified");
    result.data.runtime.state = "pending";
    expect(runtimeReadiness("tenant", result).state).toBe("pending");
    result.data.runtime.state = "applying";
    expect(runtimeReadiness("tenant", result).state).toBe("pending");
  });
  it("refreshes through the tenant-scoped official read and recovers", async () => {
    const call = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(ready());
    expect((await readRuntimeReadiness("tenant", call)).state).toBe("unverified");
    expect((await readRuntimeReadiness("tenant", call)).state).toBe("ready");
    expect(call).toHaveBeenCalledWith("get_tenant_integration", { tenant_id: "tenant" });
  });
  // #3718 review defect 2 — the platform's own "this tenant is gone" answers are
  // a first-class ORPHANED state (repaired with no flag); anything else stays
  // unverified and never triggers a repair.
  it.each([
    "tenant integration administration denied",
    "get_tenant_integration failed: tenant integration administration denied",
    "tenant integration unavailable",
    "tenant_management_denied",
    "launch denied: tenant_not_found",
  ])("an orphan answer is ORPHANED: %s", (error) => {
    expect(runtimeReadiness("tenant", { ok: false, error }).state).toBe("orphaned");
  });
  it("a timeout, a 5xx or a missing credential is NOT an orphan", () => {
    for (const error of ["The operation was aborted due to timeout", "mcp error", "HTTP 502", "no refresh token", "denied", undefined]) {
      expect(runtimeReadiness("tenant", { ok: false, error }).state).toBe("unverified");
    }
    expect(isOrphanError("tenant integration administration denied")).toBe(true);
    expect(isOrphanError("permission denied for relation")).toBe(false);
  });
  it("surfaces transport failure without throwing an admin error", async () => {
    expect((await readRuntimeReadiness("tenant", async () => { throw new Error("network"); })).state).toBe("unverified");
  });
});
