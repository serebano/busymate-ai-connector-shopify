/**
 * busymate-ai-src#3156 — a guest's public call on a v3 workspace carries no credential, only
 * the signed guest BINDING (`X-Bmai-Binding`, `typ: bmai-binding+jwt`). It binds the shop and
 * makes the caller a guest (no customer, never confirmed). The vector below is the PLATFORM's
 * pinned binding vector (busymate-ai-src packages/mcp-registry/src/actorV3/vectors.ts), copied
 * verbatim: it fails here if the vendored verifier ever drifts from the platform signer.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveCaller, type ResolveCallerDeps } from "../app/mcp/auth";
import {
  actorV3PublicJwk,
  importActorV3PrivateKey,
  mintActorV3,
  mintActorV3Binding,
  verifyActorV3,
  verifyActorV3Binding,
} from "../app/mcp/actorTokenV3";
import { loader as statusLoader } from "../app/routes/api.bmai.status";

export const ACTOR_V3_BINDING_VECTOR = {
  jwks: { keys: [{"kty": "EC", "crv": "P-256", "x": "inldohzOLbNVaO02vjihR2Ynd19uNGMZns_LxQVdrv0", "y": "fBCS0M4TNeVWoqRgy4n7gdfnnH_x2uL7IO5goxpUaxE", "kid": "bmai-actor-vector-1b", "alg": "ES256", "use": "sig"}] },
  token: [
    "eyJhbGciOiJFUzI1NiIsInR5cCI6ImJtYWktYmluZGluZytqd3QiLCJraWQiOiJibWFpLWFjdG9yLXZlY3Rvci0xYiJ9",
    "eyJpc3MiOiJodHRwczovL2J1c3ltYXRlLmFpIiwiYXVkIjoiaHR0cHM6Ly9tY3AuYWNtZS5leGFtcGxlIiwidGVuYW50X2lkIjoiMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyIiwiY29ubmVjdG9yX2lkIjoiMzMzMzMzMzMtMzMzMy00MzMzLTgzMzMtMzMzMzMzMzMzMzMzIiwiYWN0b3Jfa2luZCI6ImFub255bW91cyIsInRvb2wiOiJzZWFyY2hfcHJvZHVjdHMiLCJpYXQiOjE4MDAwMDAwMDAsIm5iZiI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMTIwLCJqdGkiOiI2NjY2NjY2Ni02NjY2LTQ2NjYtODY2Ni02NjY2NjY2NjY2NjYifQ",
    "6p0OSDfJmhSdu91jYZH7kFlOljkZL6teDa-w93x5jjAK93fxZ4wk05gCDs1gTpQDg1MyawRYsCHehHSOccsg5g",
  ].join("."),
  nowSeconds: 1800000060,
  audience: "https://mcp.acme.example",
  tenantId: "22222222-2222-4222-8222-222222222222",
  connectorId: "33333333-3333-4333-8333-333333333333",
  claims: { tool: "search_products", jti: "66666666-6666-4666-8666-666666666666", iat: 1800000000, exp: 1800000120 },
} as const;

const AUD = "https://store.busymate.ai";
const TENANT = "tnt_11111111";
const CONNECTOR = "con_22222222";
const SHOP = "acme.myshopify.com";
const NOW = Math.floor(Date.now() / 1000);

const pem = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const signer = { kid: "kid-1", privateKey: await importActorV3PrivateKey(pem()) };
const JWKS = { keys: [await actorV3PublicJwk(signer.privateKey, "kid-1")] };

async function binding(over: Partial<Parameters<typeof mintActorV3Binding>[0]> = {}, key = signer): Promise<string> {
  return (await mintActorV3Binding({ audience: AUD, tenantId: TENANT, connectorId: CONNECTOR, tool: "search_products", nowSeconds: NOW, ...over }, key)).token;
}

function deps(over: Partial<ResolveCallerDeps> = {}): ResolveCallerDeps {
  return {
    resolveShop: async (t, c) => (t === TENANT && c === CONNECTOR ? SHOP : null),
    master: "test-master-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUV", audience: AUD, now: NOW, headerCallerAllowed: false,
    actorJwks: async () => JWKS,
    ...over,
  };
}

const req = (headers: Record<string, string>) => new Request(`${AUD}/mcp`, { method: "POST", headers });

describe("guest binding — the platform conformance vector", () => {
  const v = ACTOR_V3_BINDING_VECTOR;
  const at = { audience: v.audience, tenantId: v.tenantId, connectorId: v.connectorId, nowSeconds: v.nowSeconds };
  it("accepts the vector at its pinned clock", async () => {
    const claims = await verifyActorV3Binding(v.token, v.jwks, at);
    expect(claims).toMatchObject({ tool: v.claims.tool, jti: v.claims.jti, actor_kind: "anonymous" });
  });
  it("refuses it on a wrong audience, tenant, connector or clock", async () => {
    for (const bad of [{ audience: "https://mcp.other.example" }, { tenantId: "x" }, { connectorId: "x" }, { nowSeconds: 1800000131 }]) {
      expect(await verifyActorV3Binding(v.token, v.jwks, { ...at, ...bad })).toBeNull();
    }
  });
  it("is never an identity: the actor verifier refuses it", async () => {
    expect(await verifyActorV3(v.token, v.jwks, at)).toBeNull();
  });
});

describe("resolveCaller with the guest binding", () => {
  it("binding alone ⇒ a guest of the bound shop: no customer, never confirmed", async () => {
    const caller = await resolveCaller(req({ "x-bmai-binding": await binding() }), deps());
    expect(caller).toEqual({
      shop: SHOP, customerId: null, confirmed: false, actor: "bmai", actorVersion: 3, actorJti: expect.any(String), binding: true,
    });
  });
  it("fails closed: forged key, wrong audience, unknown shop binding, expired, no JWKS", async () => {
    const other = { kid: "kid-1", privateKey: await importActorV3PrivateKey(pem()) };
    expect(await resolveCaller(req({ "x-bmai-binding": await binding({}, other) }), deps())).toBeNull();
    expect(await resolveCaller(req({ "x-bmai-binding": await binding({ audience: "https://evil.example" }) }), deps())).toBeNull();
    expect(await resolveCaller(req({ "x-bmai-binding": await binding({ connectorId: "con_other" }) }), deps())).toBeNull();
    expect(await resolveCaller(req({ "x-bmai-binding": await binding({ nowSeconds: NOW - 300 }) }), deps())).toBeNull();
    expect(await resolveCaller(req({ "x-bmai-binding": await binding() }), deps({ actorJwks: undefined }))).toBeNull();
    expect(await resolveCaller(req({ "x-bmai-binding": "garbage" }), deps())).toBeNull();
  });
  it("an identity token in the binding header is refused, never read as a customer", async () => {
    const actor = (await mintActorV3({
      audience: AUD, subject: "cust_1", identityProviderId: "idp", tenantId: TENANT, connectorId: CONNECTOR,
      sessionId: "s", confirmed: true, tool: "list_my_orders", nowSeconds: NOW,
    }, signer)).token;
    expect(await resolveCaller(req({ "x-bmai-binding": actor }), deps())).toBeNull();
  });
  it("a bad binding never falls through to the dev header caller", async () => {
    const r = req({ "x-bmai-binding": "garbage", "x-bmai-shop": SHOP });
    expect(await resolveCaller(r, deps({ headerCallerAllowed: true }))).toBeNull();
  });
  it("is ignored beside a real credential: Authorization or X-Bmai-Actor decides", async () => {
    const actor = (await mintActorV3({
      audience: AUD, subject: "cust_1", identityProviderId: "idp", tenantId: TENANT, connectorId: CONNECTOR,
      sessionId: "s", confirmed: false, tool: "list_my_orders", nowSeconds: NOW,
    }, signer)).token;
    const caller = await resolveCaller(req({ "x-bmai-actor": actor, "x-bmai-binding": await binding() }), deps());
    expect(caller).toMatchObject({ customerId: "cust_1", actorVersion: 3 });
    expect(caller?.binding).toBeUndefined();
    expect(await resolveCaller(req({ authorization: "Bearer not-a-token", "x-bmai-binding": await binding() }), deps())).toBeNull();
  });
});

describe("/api/bmai/status declares the guest binding", () => {
  it("guestBinding: true", async () => {
    const body = (await (await statusLoader()).json()) as Record<string, unknown>;
    expect(body.guestBinding).toBe(true);
  });
});
