import { describe, expect, it, vi } from "vitest";
import { enqueueWebhookReingest, reingestRetryDelay } from "../app/lib/reingestQueue";

const receipt = { shop: "fixture.myshopify.com", webhookId: "synthetic-delivery-1", reason: "products" as const };

describe("prepared durable retrain acknowledgement boundary", () => {
  it("does not acknowledge before persistence commits", async () => {
    let commit!: (value: "enqueued") => void;
    const enqueue = vi.fn(() => new Promise<"enqueued">((resolve) => { commit = resolve; }));
    let acknowledged = false;
    const request = enqueueWebhookReingest({ enqueue }, receipt).then((out) => { acknowledged = true; return out; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(receipt);
    commit("enqueued");
    expect(await request).toEqual({ scheduled: true });
  });

  it("propagates persistence failure instead of returning queued success", async () => {
    const enqueue = vi.fn(async () => { throw new Error("synthetic database unavailable"); });
    await expect(enqueueWebhookReingest({ enqueue }, receipt)).rejects.toThrow("database unavailable");
  });

  it("accepts an already committed receipt and preserves inactive refusal", async () => {
    expect(await enqueueWebhookReingest({ enqueue: async () => "duplicate" }, receipt)).toEqual({ scheduled: true });
    expect(await enqueueWebhookReingest({ enqueue: async () => "inactive" }, receipt)).toEqual({ scheduled: false, reason: "shop is inactive" });
    await expect(enqueueWebhookReingest({ enqueue: async () => "unexpected" as never }, receipt)).rejects.toThrow("unknown verdict");
  });

  it("does not persist orders or an unbound receipt", async () => {
    const enqueue = vi.fn(async () => "enqueued" as const);
    expect((await enqueueWebhookReingest({ enqueue }, { ...receipt, reason: "orders" })).scheduled).toBe(false);
    await expect(enqueueWebhookReingest({ enqueue }, { ...receipt, webhookId: " " })).rejects.toThrow("binding required");
    await expect(enqueueWebhookReingest({ enqueue }, { ...receipt, shop: "" })).rejects.toThrow("binding required");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("bounds retries and refuses malformed counters", () => {
    expect(reingestRetryDelay(1)).toBe(5_000);
    expect(reingestRetryDelay(2)).toBe(10_000);
    expect(reingestRetryDelay(20)).toBe(30 * 60_000);
    for (const attempt of [0, -1, 1.5, NaN, Infinity]) expect(() => reingestRetryDelay(attempt)).toThrow();
  });
});
