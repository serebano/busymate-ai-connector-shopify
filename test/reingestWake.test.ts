import { afterEach, expect, it, vi } from "vitest";
import { createReingestWake } from "../app/lib/reingestWake";
afterEach(() => vi.useRealTimers());
it("coalesces wakes during one active drain and rereads after that drain", async () => {
 vi.useFakeTimers();let release!: () => void;let active=0,max=0;
 const drain=vi.fn(async()=>{active++;max=Math.max(max,active);if(drain.mock.calls.length===1)await new Promise<void>(r=>{release=r;});active--;});
 const nextDelay=vi.fn(async()=>20000);const worker=createReingestWake({drain,nextDelay});
 worker.wake();worker.wake();worker.wake();expect(drain).toHaveBeenCalledTimes(1);
 release();await vi.advanceTimersByTimeAsync(1);expect(drain).toHaveBeenCalledTimes(2);expect(max).toBe(1);expect(nextDelay).toHaveBeenCalledTimes(2);await worker.stop();
});
it("uses authoritative due time, not the fallback interval, for normal work", async () => {
 vi.useFakeTimers();const drain=vi.fn(async()=>undefined);const worker=createReingestWake({drain,nextDelay:async()=>20000});
 worker.wake();await vi.advanceTimersByTimeAsync(19999);expect(drain).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);expect(drain).toHaveBeenCalledTimes(2);await worker.stop();
});
it("falls back after a read failure and stops without another drain", async () => {
 vi.useFakeTimers();const drain=vi.fn(async()=>{throw Error("synthetic DB outage");});const worker=createReingestWake({drain,nextDelay:async()=>0});
 worker.wake();await vi.advanceTimersByTimeAsync(30000);expect(drain).toHaveBeenCalledTimes(2);
 await worker.stop();await vi.advanceTimersByTimeAsync(60000);worker.wake();expect(drain).toHaveBeenCalledTimes(2);
});
