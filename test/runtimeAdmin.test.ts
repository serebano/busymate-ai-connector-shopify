import { beforeEach, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const mocks = vi.hoisted(() => ({
  read: vi.fn(), tenant: vi.fn(), install: vi.fn(),
}));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: async () => ({ session: { shop: "test.myshopify.com" } }) } }));
vi.mock("../app/db.server", () => ({ default: { shopTenant: { findUnique: mocks.tenant } } }));
vi.mock("../app/bmai.server", () => ({ callMcpTool: mocks.read, onAppInstalled: mocks.install }));
vi.mock("../app/lib/retrain.server", () => ({ readTrainingState: () => ({ trainedAt: null, error: null, counts: null }), runRetrain: vi.fn() }));
vi.mock("../app/lib/themeEmbed", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/themeEmbed")>(), detectStorefrontEmbed: async () => "on",
}));
// The Reconnect settle wait (#2618) runs without real sleeps here.
vi.mock("../app/lib/runtimeReadiness", async importOriginal => {
  const real = await importOriginal<typeof import("../app/lib/runtimeReadiness")>();
  return { ...real, awaitRuntimeSettled: (read: () => Promise<import("../app/lib/runtimeReadiness").RuntimeReadiness>) => real.awaitRuntimeSettled(read, { sleep: async () => {}, timeoutMs: 4000 }) };
});
import { loader, action } from "../app/routes/app._index";
import { loader as connectorLoader, action as connectorAction } from "../app/routes/app.connector";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockResolvedValue({ bmaiTenantId: "t", slug: "test", provisionState: "published", connectorId: "c" });
});
const args = () => ({ request: new Request("https://app.example/app", { method: "POST", body: new URLSearchParams({ intent: "reprovision" }) }) });

it.each(["ready", "pending", "error", "denied"])("admin surfaces report actual %s state after publication", async state => {
  mocks.read.mockResolvedValue(state === "denied" ? { ok: false } : { ok: true, data: {
    ok: true, tenant: { id: "t", status: "active" }, publication: { revision: { revision: 2, status: "published" } },
    runtime: { state, desired_revision: 2, applied_revision: 2 },
  } });
  const home = await loader(args() as LoaderFunctionArgs);
  expect(home.live).toBe(state === "ready");
  expect(home.connectorReady).toBe(state === "ready");
  expect(home.steps.find(s => s.id === "provisioned")?.done).toBe(state === "ready");
  expect((await action(args() as ActionFunctionArgs)).ok).toBe(state === "ready");
  expect((await connectorLoader(args() as LoaderFunctionArgs)).runtime?.state).toBe(state === "denied" ? "unverified" : state);
  // #2618: Reconnect reports a still-activating runtime (pending after a fresh publish) as set up, not as a failure.
  const reconnect = await connectorAction(args() as ActionFunctionArgs);
  expect(reconnect.ok).toBe(state === "ready" || state === "pending");
  expect("activating" in reconnect && reconnect.activating).toBe(state === "pending");
});
