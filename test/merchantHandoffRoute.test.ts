import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), tenant: vi.fn(), call: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: mocks.authenticate } }));
vi.mock("../app/db.server", () => ({ default: { shopTenant: { findUnique: mocks.tenant } } }));
vi.mock("../app/bmai.server", () => ({ callMcpTool: mocks.call }));
import { action, loader } from "../app/routes/app.handoffs.$requestId";
import { loader as transcriptLoader } from "../app/routes/app.transcripts.$sessionId";

const ID = "20000000-0000-4000-8000-000000000002";
const TENANT = "10000000-0000-4000-8000-000000000001";
const SHOP = "owned.myshopify.com";
const packet = (result: unknown) => ({ ok: true, data: { ok: true, result } });
const args = (post = false) => ({
  request: new Request(`https://store.busymate.ai/app/handoffs/${ID}?tenant_id=forged&shop=forged.myshopify.com`, post ? {
    method: "POST", body: new URLSearchParams({ intent: "claim", confirm: "yes", tenant_id: "forged", request_id: "forged", session_id: "forged" }),
  } : undefined), params: { requestId: ID }, context: {},
  url: new URL(`https://store.busymate.ai/app/handoffs/${ID}`), pattern: "/app/handoffs/:requestId",
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ session: { shop: SHOP } });
  mocks.tenant.mockResolvedValue({ bmaiTenantId: TENANT });
  mocks.call.mockImplementation(async (name: string) => {
    if (name === "list_tenant_interventions") return packet({ interventions: [{ id: ID }] });
    if (name === "get_tenant_intervention") return packet({ request: { id: ID, status: "requested" }, messages: [] });
    return packet({ ok: true, id: ID, requestId: ID, tenantId: TENANT, status: "active" });
  });
});

describe("Shopify handoff route authorization", () => {
  it.each(["read", "write"])("requires Shopify admin authentication before %s", async (kind) => {
    const denied = new Response("Unauthorized", { status: 401 });
    mocks.authenticate.mockRejectedValue(denied);
    const operation = kind === "read" ? loader(args() as LoaderFunctionArgs) : action(args(true) as ActionFunctionArgs);
    await expect(operation).rejects.toBe(denied);
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("derives the tenant only from the authenticated shop on reads", async () => {
    expect(await loader(args() as LoaderFunctionArgs)).toMatchObject({ ok: true });
    expect(mocks.tenant).toHaveBeenCalledWith({ where: { shop: SHOP }, select: { bmaiTenantId: true } });
    expect(mocks.call).toHaveBeenNthCalledWith(1, "list_tenant_interventions", { tenant_id: TENANT, status: "all" });
  });
  it("ignores forged body/query ownership on writes", async () => {
    expect(await action(args(true) as ActionFunctionArgs)).toMatchObject({ ok: true });
    expect(mocks.call).toHaveBeenLastCalledWith("claim_tenant_intervention", { tenant_id: TENANT, request_id: ID, confirm: true });
  });
  it("never fetches or mutates an ID missing from the authenticated shop's list", async () => {
    mocks.call.mockResolvedValue(packet({ interventions: [] }));
    expect(await action(args(true) as ActionFunctionArgs)).toMatchObject({ ok: false });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("requires Shopify admin authentication for an ordinary transcript", async () => {
    const denied = new Response("Unauthorized", { status: 401 });
    mocks.authenticate.mockRejectedValue(denied);
    await expect(transcriptLoader({ ...args(), params: { sessionId: "wrun_01TESTSESSION" } } as LoaderFunctionArgs)).rejects.toBe(denied);
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
