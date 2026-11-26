import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reconnectResultMessage, retrainResultMessage } from "../app/lib/connectionView";

/** Review2 D3b — Reconnect's result is said in words that stay on the page, not only in a 5 s toast. */
describe("Store connection results (review2 D3b)", () => {
  it("Reconnect: live / activating / failed", () => {
    expect(reconnectResultMessage({ ok: true })).toBe("Store connection is live");
    expect(reconnectResultMessage({ ok: true, activating: true })).toMatch(/goes live in a moment/);
    expect(reconnectResultMessage({ ok: false, error: "Plain reason." })).toBe("Plain reason.");
    expect(reconnectResultMessage({ ok: false })).toMatch(/isn't live yet/);
  });
  it("Re-train: trained / queued / failed", () => {
    expect(retrainResultMessage({ ok: true, summary: "13 of 17 products" })).toBe("Trained on 13 of 17 products");
    expect(retrainResultMessage({ ok: true, queued: true })).toMatch(/already running/);
    expect(retrainResultMessage({ ok: false })).toMatch(/didn't finish/);
  });
  it("the page renders the last result inline (role=status) besides the toast", () => {
    const src = readFileSync("app/routes/app.connector.tsx", "utf8");
    expect(src).toMatch(/role="status"[\s\S]*reconnectResultMessage\(result\)/);
    expect(src).toMatch(/role="status"[\s\S]*retrainResultMessage\(result\)/);
    expect(src).toMatch(/toast\.show\(reconnectResultMessage\(d\)/);
  });
});
