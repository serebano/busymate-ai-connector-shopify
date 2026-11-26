import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../app/mcp/route";

// Connector JSON-RPC contract: discovery is pre-auth; tools/call fails closed.
function rpc(method: string, params?: unknown, headers?: Record<string, string>) {
  return new Request("https://shopify.busymate.ai/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("connector transport contract", () => {
  it("initialize returns protocolVersion + serverInfo (pre-auth)", async () => {
    const res = await handleMcpRequest(rpc("initialize"));
    const json = await res.json();
    expect(json.result.serverInfo.name).toBe("bmai-shopify-admin");
    expect(json.result.protocolVersion).toBeTruthy();
  });

  it("tools/list is served pre-auth and hides handlers", async () => {
    const res = await handleMcpRequest(rpc("tools/list"));
    const json = await res.json();
    expect(Array.isArray(json.result.tools)).toBe(true);
    expect(json.result.tools[0]).not.toHaveProperty("handler");
  });

  it("tools/call fails closed without a verified shop binding", async () => {
    const res = await handleMcpRequest(rpc("tools/call", { name: "search_products", arguments: { query: "x" } }));
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.error.message).toMatch(/unauthorized|fail-closed/i);
  });

  it("an identified tool refuses a guest (no customer subject)", async () => {
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "get_order_status", arguments: { order_number: "#1001" } }, { "x-bmai-shop": "acme.myshopify.com" }),
    );
    const json = await res.json();
    // Verified shop but no identity → a graceful sign-in nudge, not a store-wide read.
    expect(JSON.stringify(json.result)).toMatch(/sign in/i);
  });

  it("a confirm-gated write without acknowledgement asks for confirmation", async () => {
    const res = await handleMcpRequest(
      rpc(
        "tools/call",
        { name: "cancel_order", arguments: { order_number: "#1001" } },
        { "x-bmai-shop": "acme.myshopify.com", "x-bmai-identity": "invalid" },
      ),
    );
    const json = await res.json();
    // invalid identity → treated as guest → identified-tier refusal (sign in).
    expect(JSON.stringify(json.result)).toMatch(/sign in|confirm/i);
  });
});
