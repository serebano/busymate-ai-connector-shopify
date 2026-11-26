/**
 * ECO-03 — a signed actor credential authorizes ONE call of ONE tool.
 *
 *   - the v3 `tool` claim is carried through `resolveCaller` and the transport refuses any other
 *     tool BEFORE a side effect (a credential the customer confirmed for tool A never runs B);
 *   - the v3 jti (and the guest binding's) is burned before any side effect: a replay is refused;
 *   - a v2 jti is burned for a confirmed write (v2 has no tool claim; the platform's unattended
 *     checker reuses one unconfirmed v2 token across several reads, which must keep working);
 *   - expired tokens and a failing single-use store fail closed.
 *
 * "Side effect" is observed as `adminForShop` being reached: it is the only path to Admin GraphQL.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveCaller, type ResolveCallerDeps } from "../app/mcp/auth";
import { actorV3PublicJwk, importActorV3PrivateKey, mintActorV3, mintActorV3Binding } from "../app/mcp/actorTokenV3";
import { jtiStoreOver, type ConsumeJti } from "../app/mcp/jtiStore";
import { handleMcpRequest } from "../app/mcp/route";
import type { ShopifyAdminClient } from "../app/mcp/shopifyAdmin";

const MASTER = "test-master-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUV";
const AUD = "https://store.busymate.ai";
const TENANT = "tnt_11111111";
const CONNECTOR = "con_22222222";
const SHOP = "acme.myshopify.com";
const NOW = Math.floor(Date.now() / 1000);

const pem = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const signer = { kid: "kid-1", privateKey: await importActorV3PrivateKey(pem) };
const JWKS = { keys: [await actorV3PublicJwk(signer.privateKey, "kid-1")] };

async function v3(over: Partial<Parameters<typeof mintActorV3>[0]> = {}): Promise<string> {
  return (await mintActorV3({
    audience: AUD, subject: "cust_1", identityProviderId: "idp_1", tenantId: TENANT, connectorId: CONNECTOR,
    sessionId: "sess_1", confirmed: false, tool: "list_my_orders", nowSeconds: NOW, ...over,
  }, signer)).token;
}

function v2(payload: Record<string, unknown> = {}): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const h = b64({ alg: "HS256", typ: "JWT", kid: "bmai-support-v2" });
  const p = b64({
    iss: "https://busymate.ai", aud: AUD, sub: "cust_1", actor_kind: "identified", tenant_id: TENANT,
    connector_id: CONNECTOR, support_session_id: "sess_1", policy_revision: 1, iat: NOW, nbf: NOW - 5,
    exp: NOW + 300, jti: `jti_v2_${crypto.randomUUID()}`, ...payload,
  });
  const secret = crypto.createHmac("sha256", MASTER).update("bmai-support-actor:v2\n").update(TENANT).update("\n").update(CONNECTOR).digest();
  return `${h}.${p}.${crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}

function callerDeps(over: Partial<ResolveCallerDeps> = {}): ResolveCallerDeps {
  return {
    resolveShop: async (t, c) => (t === TENANT && c === CONNECTOR ? SHOP : null),
    master: MASTER, audience: AUD, now: NOW, headerCallerAllowed: false,
    actorJwks: async () => JWKS,
    ...over,
  };
}

/** A transport over the REAL resolveCaller + gates, an in-memory single-use store and a counting admin. */
function harness(opts: { consume?: ConsumeJti; callerOver?: Partial<ResolveCallerDeps> } = {}) {
  const used = new Set<string>();
  const state = { adminCalls: 0, burned: [] as string[] };
  const consume: ConsumeJti = opts.consume ?? (async (key) => {
    if (used.has(key)) return false;
    used.add(key);
    state.burned.push(key);
    return true;
  });
  const admin: ShopifyAdminClient = { shop: SHOP, graphql: async () => ({ data: {} }) };
  const call = async (name: string, headers: Record<string, string>, args: Record<string, unknown> = {}) => {
    const request = new Request(`${AUD}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const res = await handleMcpRequest(request, {
      resolveCaller: (r) => resolveCaller(r, callerDeps(opts.callerOver)),
      consumeJti: consume,
      adminForShop: async () => { state.adminCalls++; return admin; },
    });
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  };
  return { call, state };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("ECO-03 — positive path", () => {
  it("a v3 token signed for tool A runs tool A once, burning its jti", async () => {
    const h = harness();
    const json = await h.call("list_my_orders", bearer(await v3()));
    expect(json.error).toBeUndefined();
    expect(h.state.adminCalls).toBe(1);
    expect(h.state.burned).toHaveLength(1);
    expect(h.state.burned[0]).toMatch(/^v3:tnt_11111111:con_22222222:/);
  });

  it("a confirmed v3 write for its own tool runs", async () => {
    const h = harness();
    const json = await h.call("cancel_order", bearer(await v3({ tool: "cancel_order", confirmed: true })), { order_number: "#1001" });
    expect(json.error).toBeUndefined();
    expect(h.state.adminCalls).toBe(1);
  });

  it("a guest binding runs its own public tool", async () => {
    const h = harness();
    const token = (await mintActorV3Binding({ audience: AUD, tenantId: TENANT, connectorId: CONNECTOR, tool: "search_products", nowSeconds: NOW }, signer)).token;
    const json = await h.call("search_products", { "x-bmai-binding": token }, { query: "x" });
    expect(json.error).toBeUndefined();
    expect(h.state.adminCalls).toBe(1);
    expect(h.state.burned[0]).toMatch(/^binding:/);
  });

  it("an unconfirmed v2 token may serve several reads (the platform checker reuses it)", async () => {
    const h = harness();
    const token = v2();
    for (const tool of ["list_my_orders", "get_order_status", "list_my_orders"]) {
      const json = await h.call(tool, bearer(token), { order_number: "#1001" });
      expect(json.error).toBeUndefined();
    }
    expect(h.state.adminCalls).toBe(3);
    expect(h.state.burned).toHaveLength(0);
  });
});

describe("ECO-03 — signed tool is enforced", () => {
  it("a credential confirmed for tool A cannot call tool B (refused before any side effect)", async () => {
    const h = harness();
    const token = await v3({ tool: "update_shipping_address", confirmed: true });
    const json = await h.call("cancel_order", bearer(token), { order_number: "#1001" });
    expect(json.error?.code).toBe(-32001);
    expect(json.error?.message).toMatch(/different tool/);
    expect(h.state.adminCalls).toBe(0);
    // The refusal burned nothing, so the legit call for A still runs.
    expect(h.state.burned).toHaveLength(0);
    expect((await h.call("update_shipping_address", bearer(token), {})).error).toBeUndefined();
  });

  it("the same holds when v3 rides X-Bmai-Actor beside a v2 bearer (dual-sign)", async () => {
    const h = harness();
    const json = await h.call("cancel_order", { ...bearer(v2({ confirmed: true })), "x-bmai-actor": await v3({ tool: "get_order_status", confirmed: true }) });
    expect(json.error?.message).toMatch(/different tool/);
    expect(h.state.adminCalls).toBe(0);
  });

  it("a guest binding for one public tool cannot call another tool", async () => {
    const h = harness();
    const token = (await mintActorV3Binding({ audience: AUD, tenantId: TENANT, connectorId: CONNECTOR, tool: "search_products", nowSeconds: NOW }, signer)).token;
    const json = await h.call("get_product", { "x-bmai-binding": token }, { id: "1" });
    expect(json.error?.message).toMatch(/different tool/);
    expect(h.state.adminCalls).toBe(0);
  });
});

describe("ECO-03 — single use", () => {
  it("a replayed v3 token is refused before any side effect", async () => {
    const h = harness();
    const token = await v3({ tool: "cancel_order", confirmed: true });
    expect((await h.call("cancel_order", bearer(token), { order_number: "#1001" })).error).toBeUndefined();
    const replay = await h.call("cancel_order", bearer(token), { order_number: "#1001" });
    expect(replay.error?.code).toBe(-32001);
    expect(replay.error?.message).toMatch(/already used/);
    expect(h.state.adminCalls).toBe(1);
  });

  it("a replayed v3 read is refused too (one token = one call)", async () => {
    const h = harness();
    const token = await v3();
    await h.call("list_my_orders", bearer(token));
    expect((await h.call("list_my_orders", bearer(token))).error?.message).toMatch(/already used/);
    expect(h.state.adminCalls).toBe(1);
  });

  it("a replayed confirmed v2 write is refused", async () => {
    const h = harness();
    const token = v2({ confirmed: true });
    expect((await h.call("cancel_order", bearer(token), { order_number: "#1001" })).error).toBeUndefined();
    const replay = await h.call("cancel_order", bearer(token), { order_number: "#1001" });
    expect(replay.error?.message).toMatch(/already used/);
    expect(h.state.adminCalls).toBe(1);
  });

  it("dual-sign burns both ids: stripping the v3 header cannot replay the v2 bearer", async () => {
    const h = harness();
    const v2Token = v2({ confirmed: true });
    const headers = { ...bearer(v2Token), "x-bmai-actor": await v3({ tool: "cancel_order", confirmed: true }) };
    expect((await h.call("cancel_order", headers, { order_number: "#1001" })).error).toBeUndefined();
    expect(h.state.burned.map((k) => k.split(":")[0]).sort()).toEqual(["v2", "v3"]);
    expect((await h.call("cancel_order", bearer(v2Token), { order_number: "#1001" })).error?.message).toMatch(/already used/);
    expect(h.state.adminCalls).toBe(1);
  });

  it("a failing single-use store fails closed", async () => {
    const h = harness({ consume: async () => { throw new Error("db down"); } });
    expect((await h.call("list_my_orders", bearer(await v3()))).error?.message).toMatch(/already used/);
    expect(h.state.adminCalls).toBe(0);
  });
});

describe("ECO-03 — expiry", () => {
  it("an expired v3 token is refused (no shop binding), nothing burned, no side effect", async () => {
    const h = harness();
    const json = await h.call("list_my_orders", bearer(await v3({ nowSeconds: NOW - 300 })));
    expect(json.error?.message).toMatch(/unauthorized/);
    expect(h.state.adminCalls).toBe(0);
    expect(h.state.burned).toHaveLength(0);
  });

  it("an expired v2 token is refused", async () => {
    const h = harness();
    const json = await h.call("list_my_orders", bearer(v2({ iat: NOW - 400, nbf: NOW - 400, exp: NOW - 100 })));
    expect(json.error?.message).toMatch(/unauthorized/);
    expect(h.state.adminCalls).toBe(0);
  });
});

describe("jtiStoreOver — the Postgres single-use store", () => {
  it("first insert wins, a duplicate is a replay, a DB error fails closed, expiry = exp + skew", async () => {
    const rows = new Map<string, Date>();
    const db = {
      $executeRaw: async (q: TemplateStringsArray, ...v: unknown[]) => {
        if (q.join("?").startsWith("DELETE")) return 0;
        const [key, at] = v as [string, Date];
        if (rows.has(key)) return 0;
        rows.set(key, at);
        return 1;
      },
    };
    const consume = jtiStoreOver(db, () => 1);
    expect(await consume("k1", 1_800_000_120)).toBe(true);
    expect(await consume("k1", 1_800_000_120)).toBe(false);
    expect(rows.get("k1")?.getTime()).toBe((1_800_000_120 + 10) * 1000);
    expect(await consume("", 1)).toBe(false);
    const broken = jtiStoreOver({ $executeRaw: async () => { throw new Error("down"); } }, () => 1);
    expect(await broken("k2", 1_800_000_120)).toBe(false);
  });
});
