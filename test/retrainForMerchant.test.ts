import { describe, expect, it, vi } from "vitest";

// ingest.ts imports the db + bmai seams at module load; the function under test takes its deps.
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/bmai.server", () => ({ publishTenantRuntime: vi.fn() }));
vi.mock("../app/lib/reingestStore.server", () => ({ reingestStore: {}, requestImmediateReingest: vi.fn(), saveTrainingForLease: vi.fn() }));

const { retrainForMerchant } = await import("../app/lib/ingest");
const { TRAINING_NOT_STARTED } = await import("../app/lib/kbFreshness");

const zero = { products: 0, policies: 0, pages: 0 };
const busy = { ok: false, error: TRAINING_NOT_STARTED, counts: zero, fetched: zero, totalChars: 0, truncated: false };
const done = { ok: true, counts: { products: 15, policies: 1, pages: 2 }, fetched: zero, totalChars: 10, truncated: false };
const noSleep = async () => {};

// #2624 walk — Re-train right after install showed a RED "Training is queued, already
// running, or the shop is inactive" because the webhook worker held the lease.
describe("retrainForMerchant", () => {
  it("RED→GREEN: waits for the running pass and then trains", async () => {
    const train = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(busy).mockResolvedValueOnce(done);
    const out = await retrainForMerchant("s.myshopify.com", { train, sleep: noSleep, isInactive: async () => false });
    expect(out.ok).toBe(true);
    expect(out.queued).toBeUndefined();
    expect(train).toHaveBeenCalledTimes(3);
  });
  it("still busy after the wait → accepted as queued, never an error", async () => {
    const out = await retrainForMerchant("s.myshopify.com", { train: async () => busy, sleep: noSleep, isInactive: async () => false, waitMs: 10, intervalMs: 5 });
    expect(out).toMatchObject({ ok: true, queued: true });
    expect(out.error).toBeUndefined();
  });
  it("an inactive shop is still refused", async () => {
    const out = await retrainForMerchant("s.myshopify.com", { train: async () => busy, sleep: noSleep, isInactive: async () => true });
    expect(out.ok).toBe(false);
  });
  it("a real failure is reported unchanged", async () => {
    const fail = { ...busy, error: "publish failed" };
    const out = await retrainForMerchant("s.myshopify.com", { train: async () => fail, sleep: noSleep, isInactive: async () => false });
    expect(out).toMatchObject({ ok: false, error: "publish failed" });
  });
});
