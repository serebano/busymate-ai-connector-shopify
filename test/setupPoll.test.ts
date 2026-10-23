// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSettingUp, SETUP_POLL_MAX, SETUP_POLL_MS, useSetupPoll } from "../app/lib/useSetupPoll";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("src#2624 final — Home re-reads every 1.5 s while the install is being set up", () => {
  it("isSettingUp only for pending/provisioning", () => {
    expect(isSettingUp("pending")).toBe(true);
    expect(isSettingUp("provisioning")).toBe(true);
    expect(isSettingUp("published")).toBe(false);
    expect(isSettingUp("runtime-pending")).toBe(false);
    expect(isSettingUp("error")).toBe(false);
  });

  it("revalidates every SETUP_POLL_MS while active, stops when the state settles, and is bounded", async () => {
    let loads = 0;
    let state = "provisioning";
    function Page() { const d = useLoaderData() as { state: string }; useSetupPoll(isSettingUp(d.state)); return createElement("div", null, d.state); }
    const router = createMemoryRouter([{ path: "/", loader: () => { loads += 1; return { state }; }, Component: Page }]);
    const el = document.createElement("div"); let root: Root;
    await act(async () => { root = createRoot(el); root.render(createElement(RouterProvider, { router })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const first = loads;
    await act(async () => { await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3); });
    expect(loads - first).toBe(3);
    state = "published";
    await act(async () => { await vi.advanceTimersByTimeAsync(SETUP_POLL_MS); });
    const settled = loads;
    await act(async () => { await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 10); });
    expect(loads).toBe(settled);
    expect(el.textContent).toBe("published");
    expect(SETUP_POLL_MAX * SETUP_POLL_MS).toBeLessThanOrEqual(60_000);
    await act(async () => root!.unmount());
  });
});
