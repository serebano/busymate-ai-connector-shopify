import { describe, expect, it } from "vitest";
import { connectionView } from "../app/lib/connectionView";

const base = { connectorId: "c1", provisionState: "published", provisionWarning: null };

describe("#2624 reviewer W12 — Store connection status during a re-publish", () => {
  it("pending (a re-train/reconnect re-publish in progress) is Connected and re-checks by itself", () => {
    const v = connectionView({ ...base, runtime: "pending" });
    expect(v.connected).toBe(true);
    expect(v.badge.label).toBe("Connected");
    expect(v.recheck).toBe(true);
    expect(v.note).toMatch(/updates by itself/);
  });
  it("ready is Connected and stops re-checking", () => {
    const v = connectionView({ ...base, runtime: "ready" });
    expect(v).toMatchObject({ connected: true, recheck: false, note: null });
  });
  it("a failed read is Checking (not Not connected) and re-checks", () => {
    const v = connectionView({ ...base, runtime: "unverified" });
    expect(v.badge.label).toBe("Checking");
    expect(v.recheck).toBe(true);
  });
  it("error and an unregistered connector are not connected", () => {
    expect(connectionView({ ...base, provisionState: "error", runtime: "ready" }).badge.label).toBe("Error");
    expect(connectionView({ ...base, connectorId: null, runtime: "ready" }).connected).toBe(false);
    expect(connectionView({ ...base, runtime: "error" }).badge.label).toBe("Not connected");
  });
});
