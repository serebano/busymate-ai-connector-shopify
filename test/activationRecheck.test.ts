// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startActivationRecheck, type RecheckRevalidator } from "../app/lib/activationRecheck";
import { RECHECK_FAST_MS, RECHECK_FAST_TICKS, RECHECK_SLOW_MS } from "../app/lib/embedFrameable";
import { useActivationRecheck } from "../app/lib/useActivationRecheck";

/**
 * #3718 re-review defect 2 — Home's "taking longer" banner and its Retry setup
 * never rendered. The re-check effect listed `useRevalidator()` as a dependency;
 * react-router 7 returns a NEW object each time `state.revalidation` changes, so
 * every 5 s re-check tore the loop down and restarted it at tick 0 — Home polled
 * every 5 s forever and `slow` never flipped. The pure `recheckDelayMs` /
 * `recheckIsSlow` tests could not see that; the second block below drives the
 * hook Home uses inside a real data router, where the revalidator really does
 * change identity on every re-check.
 */

const FAST_PHASE_MS = RECHECK_FAST_TICKS * RECHECK_FAST_MS; // 5 minutes

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startActivationRecheck (the loop)", () => {
  function fakeRevalidator(state = "idle") {
    const r = { state, calls: 0, revalidate: () => { r.calls += 1; } };
    return r;
  }

  it("re-checks every 5 s, turns slow at 5 minutes, then re-checks every 30 s", async () => {
    const revalidator = fakeRevalidator();
    const slowSeen: boolean[] = [];
    const stop = startActivationRecheck({ revalidator: () => revalidator, onSlow: (s) => slowSeen.push(s) });
    await vi.advanceTimersByTimeAsync(RECHECK_FAST_MS - 1);
    expect(revalidator.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(revalidator.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(FAST_PHASE_MS - RECHECK_FAST_MS);
    expect(revalidator.calls).toBe(RECHECK_FAST_TICKS);
    expect(slowSeen.at(-1)).toBe(true);
    expect(slowSeen.slice(0, RECHECK_FAST_TICKS - 1).every((s) => s === false)).toBe(true);
    await vi.advanceTimersByTimeAsync(RECHECK_SLOW_MS - 1);
    expect(revalidator.calls).toBe(RECHECK_FAST_TICKS);
    await vi.advanceTimersByTimeAsync(1);
    expect(revalidator.calls).toBe(RECHECK_FAST_TICKS + 1);
    stop();
    await vi.advanceTimersByTimeAsync(10 * RECHECK_SLOW_MS);
    expect(revalidator.calls).toBe(RECHECK_FAST_TICKS + 1);
  });

  it("asks the CURRENT revalidator at every tick and never doubles one in flight", async () => {
    let current: RecheckRevalidator & { calls: number } = fakeRevalidator();
    const first = current;
    const stop = startActivationRecheck({ revalidator: () => current, onSlow: () => undefined });
    await vi.advanceTimersByTimeAsync(RECHECK_FAST_MS);
    expect(first.calls).toBe(1);
    current = fakeRevalidator("loading");
    await vi.advanceTimersByTimeAsync(RECHECK_FAST_MS);
    expect(current.calls).toBe(0);
    current = fakeRevalidator();
    await vi.advanceTimersByTimeAsync(RECHECK_FAST_MS);
    expect(current.calls).toBe(1);
    expect(first.calls).toBe(1);
    stop();
    stop();
  });
});

describe("useActivationRecheck inside a real react-router data router", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
  });

  // The real loader is three network round trips; a synchronous one would let
  // `loading` and `idle` land in ONE render, the revalidator would keep its
  // identity, and the old bug would pass unseen. So the loader takes 1.5 s and
  // time advances in 0.5 s acts: Home renders `loading`, then `idle`.
  const LOADER_MS = 1_500;
  const STEP_MS = 500;

  async function mountHome(activating: { value: boolean }) {
    const loads = { count: 0 };
    function Home() {
      const data = useLoaderData() as { recheck: boolean };
      const slow = useActivationRecheck(data.recheck);
      return createElement("output", null, slow ? "slow" : "fast");
    }
    const router = createMemoryRouter([
      {
        path: "/",
        loader: async () => {
          loads.count += 1;
          const value = activating.value;
          await new Promise((resolve) => setTimeout(resolve, LOADER_MS));
          return { recheck: value };
        },
        Component: Home,
        HydrateFallback: () => null,
      },
    ]);
    const container = document.createElement("div");
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(RouterProvider, { router }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(LOADER_MS); });
    return { loads, text: () => container.textContent };
  }

  async function advance(ms: number) {
    // Small acts so each revalidation state change renders Home on its own
    // (the render at which the old effect was torn down and restarted).
    for (let left = ms; left > 0; left -= STEP_MS) {
      await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, left)); });
    }
  }

  it("keeps ONE loop across re-checks: the banner turns slow at 5 minutes and the cadence drops to 30 s", async () => {
    const activating = { value: true };
    const home = await mountHome(activating);
    expect(home.text()).toBe("fast");
    const initial = home.loads.count;

    await advance(RECHECK_FAST_MS);
    expect(home.loads.count).toBe(initial + 1);

    await advance(FAST_PHASE_MS - RECHECK_FAST_MS);
    expect(home.loads.count).toBe(initial + RECHECK_FAST_TICKS);
    expect(home.text()).toBe("slow");

    await advance(RECHECK_SLOW_MS - RECHECK_FAST_MS);
    expect(home.loads.count).toBe(initial + RECHECK_FAST_TICKS);
    await advance(RECHECK_FAST_MS);
    expect(home.loads.count).toBe(initial + RECHECK_FAST_TICKS + 1);
    expect(home.text()).toBe("slow");
  });

  it("stops re-checking and clears slow once the assistant can be framed", async () => {
    const activating = { value: true };
    const home = await mountHome(activating);
    await advance(FAST_PHASE_MS);
    expect(home.text()).toBe("slow");
    activating.value = false;
    await advance(RECHECK_SLOW_MS + LOADER_MS);
    expect(home.text()).toBe("fast");
    const settled = home.loads.count;
    await advance(10 * RECHECK_SLOW_MS);
    expect(home.loads.count).toBe(settled);
  });

  it("does not re-check at all when nothing is held", async () => {
    const home = await mountHome({ value: false });
    const initial = home.loads.count;
    await advance(FAST_PHASE_MS);
    expect(home.loads.count).toBe(initial);
    expect(home.text()).toBe("fast");
  });
});
