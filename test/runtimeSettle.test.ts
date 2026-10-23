import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { awaitRuntimeSettled, type RuntimeReadiness } from "../app/lib/runtimeReadiness";

// busymate-ai-src#2618 fresh-install walk: Store connection → Reconnect showed a RED toast
// "Your assistant is waiting to become active" right after a successful re-publish, because
// the runtime is `pending` for a few seconds while it takes the new revision.
const pending: RuntimeReadiness = { state: "pending", detail: "Your assistant is waiting to become active. This page checks again by itself." };
const ready: RuntimeReadiness = { state: "ready", detail: "Your published assistant is active." };
const error: RuntimeReadiness = { state: "error", detail: "activation failed" };
const noSleep = async () => {};

function reader(seq: RuntimeReadiness[]) {
  let i = 0;
  return { read: async () => seq[Math.min(i++, seq.length - 1)], calls: () => i };
}

describe("awaitRuntimeSettled", () => {
  it("RED→GREEN: waits through the post-publish pending hand-over to ready", async () => {
    const r = reader([pending, pending, ready]);
    expect(await awaitRuntimeSettled(r.read, { sleep: noSleep })).toEqual(ready);
    expect(r.calls()).toBe(3);
  });

  it("returns a non-pending state at once (no wait on ready / error)", async () => {
    const r = reader([error]);
    expect((await awaitRuntimeSettled(r.read, { sleep: noSleep })).state).toBe("error");
    expect(r.calls()).toBe(1);
  });

  it("is bounded: still pending after the timeout reports pending (never hangs the action)", async () => {
    const r = reader([pending]);
    const out = await awaitRuntimeSettled(r.read, { sleep: noSleep, timeoutMs: 6000, intervalMs: 2000 });
    expect(out.state).toBe("pending");
    expect(r.calls()).toBe(4);
  });

  it("the Reconnect action treats a settled-but-activating runtime as success, not a red toast", () => {
    const src = readFileSync("app/routes/app.connector.tsx", "utf8");
    expect(src).toContain("awaitRuntimeSettled(");
    expect(src).toMatch(/runtime\?\.state === "ready" \|\| runtime\?\.state === "pending"/);
    expect(src).toContain("goes live in a moment");
  });
});
