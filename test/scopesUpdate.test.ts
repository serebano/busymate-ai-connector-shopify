import { describe, expect, it } from "vitest";
import { handleScopesUpdate } from "../app/lib/scopesUpdate";

/**
 * app/scopes_update (#2110): when a merchant grants a new scope (e.g. the
 * `read_legal_policies` added for training) the library keeps the EXISTING
 * offline session — no token exchange, no afterAuth, so the install lifecycle
 * (and its training) never re-runs. The webhook is the one signal every existing
 * store emits on the new version's rollout, so it must (1) record the new scope
 * on the session and (2) queue a re-train — the assistant can now read what it
 * could not before.
 */
function deps() {
  const updates: Array<{ id: string; scope: string }> = [];
  const scheduled: Array<{ shop: string; reason: string }> = [];
  return {
    updates,
    scheduled,
    deps: {
      updateSessionScope: async (id: string, scope: string) => {
        updates.push({ id, scope });
      },
      scheduleReingest: async (shop: string, reason: "scopes") => {
        scheduled.push({ shop, reason });
        return { scheduled: true };
      },
    },
  };
}

describe("handleScopesUpdate", () => {
  it("records the new scope set on the session AND queues a re-train", async () => {
    const d = deps();
    const out = await handleScopesUpdate(
      { shop: "s.myshopify.com", webhookId: "synthetic-scope-event", sessionId: "offline_s.myshopify.com", current: ["read_products", "read_legal_policies"] },
      d.deps,
    );
    expect(out.scope).toBe("read_products,read_legal_policies");
    expect(out.sessionUpdated).toBe(true);
    expect(d.updates).toEqual([{ id: "offline_s.myshopify.com", scope: "read_products,read_legal_policies" }]);
    expect(out.retrain).toEqual({ scheduled: true });
    expect(d.scheduled).toEqual([{ shop: "s.myshopify.com", reason: "scopes" }]);
  });
  it("still queues a re-train when the webhook carries no session", async () => {
    const d = deps();
    const out = await handleScopesUpdate({ shop: "s.myshopify.com", webhookId: "synthetic-scope-event", sessionId: null, current: ["read_products"] }, d.deps);
    expect(out.sessionUpdated).toBe(false);
    expect(d.updates).toEqual([]);
    expect(d.scheduled).toHaveLength(1);
  });
  it("ignores a malformed payload (no scope written) but never skips the re-train", async () => {
    const d = deps();
    const out = await handleScopesUpdate({ shop: "s.myshopify.com", webhookId: "synthetic-scope-event", sessionId: "x", current: "nope" }, d.deps);
    expect(out.scope).toBeNull();
    expect(out.sessionUpdated).toBe(false);
    expect(d.updates).toEqual([]);
    expect(d.scheduled).toHaveLength(1);
  });
});
