import { describe, expect, it, vi, beforeEach } from "vitest";

const rows: { value: Array<{ shop: string; meterAlert: string; meterAlertAt: Date }> | Error } = { value: [] };
vi.mock("../app/db.server", () => ({
  default: { billingState: { findMany: async () => { if (rows.value instanceof Error) throw rows.value; return rows.value; } } },
}));
import { loader } from "../app/routes/api.billing.health";

const call = (headers: Record<string, string> = {}) =>
  loader({ request: new Request("https://store.busymate.ai/api/billing/health", { headers }), params: {}, context: {} } as never) as Promise<Response>;

describe("/api/billing/health (usage-meter alerts)", () => {
  beforeEach(() => { rows.value = []; });
  it("200 with no open alert", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, openAlerts: 0 });
  });
  it("503 with an open alert; public body has counts only (no shop domains)", async () => {
    rows.value = [{ shop: "a.myshopify.com", meterAlert: "replay hold for 3 run(s)", meterAlertAt: new Date() }];
    const r = await call();
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toMatchObject({ ok: false, openAlerts: 1 });
    expect(JSON.stringify(body)).not.toContain("a.myshopify.com");
  });
  it("503 (fail closed) when billing state is unreadable", async () => {
    rows.value = new Error("db down");
    expect((await call()).status).toBe(503);
  });
});
