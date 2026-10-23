import { afterEach, describe, expect, it, vi } from "vitest";
import { processReingestLease } from "../app/lib/reingestWorker";
import type { DurableReingestStore, ReingestLease } from "../app/lib/reingestQueue";
const lease: ReingestLease = { shop: "fixture.myshopify.com", token: "synthetic-lease-token", generation: 1, attempt: 1, expiresAt: new Date(Date.now() + 300_000) };
const success = { ok: true, counts: { products: 1, policies: 0, pages: 0 }, fetched: { products: 1, policies: 0, pages: 0 }, totalChars: 10, truncated: false };
const store = () => ({ enqueue: vi.fn(async () => "enqueued" as const), claim: vi.fn(async () => lease), owns: vi.fn(async () => true), renew: vi.fn(async () => lease as ReingestLease | null), complete: vi.fn(async () => true), retry: vi.fn(async () => true), cancel: vi.fn(async () => undefined) } satisfies DurableReingestStore);
afterEach(() => vi.useRealTimers());
describe("durable worker lease lifecycle", () => {
 it("settles only the exact successful lease", async () => {
  const db=store(); expect((await processReingestLease(lease,{store:db,run:async()=>success})).ok).toBe(true);
  expect(db.complete).toHaveBeenCalledWith(lease);expect(db.retry).not.toHaveBeenCalled();
 });
 it("does not publish after ownership is lost", async () => {
  const db=store();db.owns.mockResolvedValue(false);const run=vi.fn();
  expect((await processReingestLease(lease,{store:db,run})).ok).toBe(false);expect(run).not.toHaveBeenCalled();expect(db.complete).not.toHaveBeenCalled();
 });
 it("persists retry rather than marking failed training complete", async () => {
  const db=store();expect((await processReingestLease(lease,{store:db,run:async()=>({...success,ok:false})})).ok).toBe(false);
  expect(db.retry).toHaveBeenCalledWith(lease,5000,"training_failed");expect(db.complete).not.toHaveBeenCalled();
 });
 it("does not report success when completion CAS refuses a stale token", async () => {
  const db=store();db.complete.mockResolvedValue(false);expect((await processReingestLease(lease,{store:db,run:async()=>success})).ok).toBe(false);
 });
 it("aborts a timed out attempt and records bounded retry after it stops", async () => {
  vi.useFakeTimers();const db=store();let stopped=false;
  const pending=processReingestLease(lease,{store:db,timeoutMs:100,run:async(_l,signal)=>new Promise((_r,reject)=>signal.addEventListener("abort",()=>{stopped=true;reject(Error("stopped"));},{once:true}))});
  await vi.advanceTimersByTimeAsync(101);expect((await pending).ok).toBe(false);expect(stopped).toBe(true);expect(db.retry).toHaveBeenCalledWith(lease,5000,"attempt_timeout");
 });
 it("failed renewal aborts without releasing another worker's lease", async () => {
  vi.useFakeTimers();const db=store();db.renew.mockResolvedValue(null);
  const pending=processReingestLease(lease,{store:db,heartbeatMs:10,run:async(_l,signal)=>new Promise((_r,reject)=>signal.addEventListener("abort",()=>reject(Error("lease lost")),{once:true}))});
  await vi.advanceTimersByTimeAsync(11);expect((await pending).ok).toBe(false);expect(db.retry).not.toHaveBeenCalled();expect(db.complete).not.toHaveBeenCalled();
 });
});

describe("#2624 — a lost lease is given back, never held for the full 5 minutes", () => {
  it("RED→GREEN: ownership lost before the run → release(lease), no retry/complete", async () => {
    const db = { ...store(), release: vi.fn(async () => true) };
    db.owns.mockResolvedValue(false);
    expect((await processReingestLease(lease, { store: db, run: vi.fn() })).ok).toBe(false);
    expect(db.release).toHaveBeenCalledWith(lease);
    expect(db.retry).not.toHaveBeenCalled();
    expect(db.complete).not.toHaveBeenCalled();
  });
  it("a settle that loses ownership also releases", async () => {
    const db = { ...store(), release: vi.fn(async () => true) };
    db.complete.mockResolvedValue(false);
    await processReingestLease(lease, { store: db, run: async () => success });
    expect(db.release).toHaveBeenCalledWith(lease);
  });
  it("an ordinary failed attempt retries (no release)", async () => {
    const db = { ...store(), release: vi.fn(async () => true) };
    await processReingestLease(lease, { store: db, run: async () => { throw new Error("boom"); } });
    expect(db.retry).toHaveBeenCalled();
    expect(db.release).not.toHaveBeenCalled();
  });
});
