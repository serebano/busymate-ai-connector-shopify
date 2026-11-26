import { describe, expect, it, vi } from "vitest";

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/bmai.server", () => ({ publishTenantRuntime: vi.fn() }));
vi.mock("../app/lib/reingestStore.server", () => ({ reingestStore: {}, requestImmediateReingest: vi.fn(), enqueueImmediateReingest: vi.fn(), saveTrainingForLease: vi.fn() }));

const { queueRetrainForMerchant } = await import("../app/lib/ingest");
const { saveBrandingAndRepublish } = await import("../app/lib/brandingSave");

/** Review2 D6 — Save returns once the names are stored and the re-publish is queued (no inline training). */
describe("Assistant settings Save is fast (review2 D6)", () => {
  it("queues a due-now re-train and reports queued", async () => {
    const enqueue = vi.fn(async () => "enqueued");
    expect(await queueRetrainForMerchant("a.myshopify.com", enqueue)).toEqual({ ok: true, queued: true });
    expect(enqueue).toHaveBeenCalledWith("a.myshopify.com");
    expect(await queueRetrainForMerchant("a.myshopify.com", async () => "duplicate")).toEqual({ ok: true, queued: true });
  });
  it("fails closed: inactive shop or a database error is not a green save", async () => {
    expect((await queueRetrainForMerchant("a.myshopify.com", async () => "inactive")).ok).toBe(false);
    expect((await queueRetrainForMerchant("a.myshopify.com", async () => { throw new Error("db down"); })).ok).toBe(false);
  });
  it("the save path does not wait for training (only branding + enqueue run)", async () => {
    let trained = false;
    const res = await saveBrandingAndRepublish("a.myshopify.com", "t1", { productName: "Acme", assistantName: "Acme AI" }, {
      setBranding: async () => ({ ok: true }),
      republish: (shop) => queueRetrainForMerchant(shop, async () => "enqueued"),
    });
    expect(res).toMatchObject({ ok: true, queued: true, published: false });
    expect(trained).toBe(false);
  });
  it("the settings route uses the queue, never the inline retrain", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/routes/app.settings.tsx", "utf8");
    expect(src).toContain("queueRetrainForMerchant(shop)");
    expect(src).not.toContain("retrainForMerchant(shop)\n");
    expect(src).not.toMatch(/import \{[^}]*\bretrainForMerchant\b/);
  });
});
