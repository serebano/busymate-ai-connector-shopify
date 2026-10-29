/**
 * busymate-ai-src#3103 — `bmai.actor/3` (ES256, public JWKS) accepted beside v2.
 * The vector below is the PLATFORM's pinned public conformance vector
 * (busymate-ai-src packages/mcp-registry/src/actorV3/vectors.ts), copied verbatim:
 * it fails here if the vendored verifier ever drifts from the platform signer.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveCaller, type ResolveCallerDeps } from "../app/mcp/auth";
import { actorV3PublicJwk, importActorV3PrivateKey, mintActorV3, verifyActorV3 } from "../app/mcp/actorTokenV3";
import { loader as statusLoader } from "../app/routes/api.bmai.status";

export const ACTOR_V3_VECTOR = {
  jwks: { keys: [{"kty": "EC", "crv": "P-256", "x": "4gMay5PjB5UiNME9Id5eQWgnM7o15hnN5s-C7Ahx_dU", "y": "Fyigblzl28kZB2H_2Y6vjN1-ITW9WxHYexp-eU6s7hg", "kid": "bmai-actor-vector-1", "alg": "ES256", "use": "sig"}] },
  // Split so secret scanners do not read a test vector as a live credential (signing key discarded).
  token: [
    "eyJhbGciOiJFUzI1NiIsInR5cCI6ImJtYWktYWN0b3Irand0Iiwia2lkIjoiYm1haS1hY3Rvci12ZWN0b3ItMSJ9",
    "eyJpc3MiOiJodHRwczovL2J1c3ltYXRlLmFpIiwiYXVkIjoiaHR0cHM6Ly9tY3AuYWNtZS5leGFtcGxlIiwic3ViIjoidXNlci00MiIsImlkcCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsInRlbmFudF9pZCI6IjIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMiIsImNvbm5lY3Rvcl9pZCI6IjMzMzMzMzMzLTMzMzMtNDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsInN1cHBvcnRfc2Vzc2lvbl9pZCI6IjQ0NDQ0NDQ0LTQ0NDQtNDQ0NC04NDQ0LTQ0NDQ0NDQ0NDQ0NCIsImFjdG9yX2tpbmQiOiJpZGVudGlmaWVkIiwiY29uZmlybWVkIjpmYWxzZSwidG9vbCI6ImdldF93YWxsZXRfYmFsYW5jZSIsImlhdCI6MTgwMDAwMDAwMCwibmJmIjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAxMjAsImp0aSI6IjU1NTU1NTU1LTU1NTUtNDU1NS04NTU1LTU1NTU1NTU1NTU1NSJ9",
    "zPEEGLEisnztgT83sLPYdIvl1mo_H7J5keVcYLRud6RtXJvoCnYf37aqX7UC67Xvi2kJ_MmPkIr4I1CTeU_-fA",
  ].join("."),
  nowSeconds: 1800000060,
  audience: "https://mcp.acme.example",
  tenantId: "22222222-2222-4222-8222-222222222222",
  connectorId: "33333333-3333-4333-8333-333333333333",
  claims: {
    sub: "user-42",
    idp: "11111111-1111-4111-8111-111111111111",
    support_session_id: "44444444-4444-4444-8444-444444444444",
    tool: "get_wallet_balance",
    confirmed: false,
    jti: "55555555-5555-4555-8555-555555555555",
    iat: 1800000000,
    exp: 1800000120,
  },
} as const;

/** Expectations under which the vector token MUST be refused. */
export const ACTOR_V3_VECTOR_REFUSALS: ReadonlyArray<{ readonly why: string; readonly audience?: string; readonly tenantId?: string; readonly connectorId?: string; readonly nowSeconds?: number }> = [
  { why: "wrong audience", audience: "https://mcp.other.example" },
  { why: "audience with a path", audience: "https://mcp.acme.example/mcp" },
  { why: "wrong tenant", tenantId: "99999999-9999-4999-8999-999999999999" },
  { why: "wrong connector", connectorId: "99999999-9999-4999-8999-999999999999" },
  { why: "expired", nowSeconds: 1800000131 },
  { why: "not yet valid", nowSeconds: 1799999980 },
];

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
    exp: NOW + 300, jti: "jti_v2", ...payload,
  });
  const secret = crypto.createHmac("sha256", MASTER).update("bmai-support-actor:v2\n").update(TENANT).update("\n").update(CONNECTOR).digest();
  return `${h}.${p}.${crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}

function deps(over: Partial<ResolveCallerDeps> = {}): ResolveCallerDeps {
  return {
    resolveShop: async (t, c) => (t === TENANT && c === CONNECTOR ? SHOP : null),
    master: MASTER, audience: AUD, now: NOW, headerCallerAllowed: false,
    actorJwks: async () => JWKS,
    ...over,
  };
}

const req = (headers: Record<string, string>) => new Request(`${AUD}/mcp`, { method: "POST", headers });

describe("bmai.actor/3 — the platform conformance vector", () => {
  it("accepts the vector at its pinned clock", async () => {
    const v = ACTOR_V3_VECTOR;
    const claims = await verifyActorV3(v.token, v.jwks, { audience: v.audience, tenantId: v.tenantId, connectorId: v.connectorId, nowSeconds: v.nowSeconds });
    expect(claims?.sub).toBe(v.claims.sub);
    expect(claims?.idp).toBe(v.claims.idp);
    expect(claims?.jti).toBe(v.claims.jti);
  });
  for (const r of ACTOR_V3_VECTOR_REFUSALS) {
    it(`refuses the vector: ${r.why}`, async () => {
      const v = ACTOR_V3_VECTOR;
      expect(await verifyActorV3(v.token, v.jwks, {
        audience: r.audience ?? v.audience, tenantId: r.tenantId ?? v.tenantId,
        connectorId: r.connectorId ?? v.connectorId, nowSeconds: r.nowSeconds ?? v.nowSeconds,
      })).toBeNull();
    });
  }
});

describe("resolveCaller with bmai.actor/3", () => {
  it("v3 in Authorization: identified caller, shop from its binding", async () => {
    const caller = await resolveCaller(req({ authorization: `Bearer ${await v3()}` }), deps());
    expect(caller).toMatchObject({ shop: SHOP, customerId: "cust_1", actor: "bmai", actorVersion: 3, confirmed: false });
    expect(caller?.actorJti).toBeTruthy();
  });
  it("v3 in Authorization that fails verification is refused, never downgraded", async () => {
    const other = { kid: "kid-1", privateKey: await importActorV3PrivateKey(crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()) };
    const forged = (await mintActorV3({ audience: AUD, subject: "cust_9", identityProviderId: "i", tenantId: TENANT, connectorId: CONNECTOR, sessionId: "s", confirmed: true, tool: "t", nowSeconds: NOW }, other)).token;
    expect(await resolveCaller(req({ authorization: `Bearer ${forged}` }), deps())).toBeNull();
    expect(await resolveCaller(req({ authorization: `Bearer ${await v3({ audience: "https://evil.example" })}` }), deps())).toBeNull();
    expect(await resolveCaller(req({ authorization: `Bearer ${await v3({ tenantId: "tnt_other" })}` }), deps())).toBeNull();
    expect(await resolveCaller(req({ authorization: `Bearer ${await v3()}` }), deps({ actorJwks: undefined }))).toBeNull();
  });
  it("dual-sign: v2 in Authorization + valid v3 in X-Bmai-Actor ⇒ v3 identity", async () => {
    const caller = await resolveCaller(req({ authorization: `Bearer ${v2()}`, "x-bmai-actor": await v3() }), deps());
    expect(caller).toMatchObject({ shop: SHOP, customerId: "cust_1", actorVersion: 3 });
  });
  it("dual-sign: a bad or mismatched v3 header never breaks the v2 caller", async () => {
    const bad = await resolveCaller(req({ authorization: `Bearer ${v2()}`, "x-bmai-actor": "garbage" }), deps());
    expect(bad).toMatchObject({ shop: SHOP, customerId: "cust_1", actorVersion: 2 });
    const other = await resolveCaller(req({ authorization: `Bearer ${v2()}`, "x-bmai-actor": await v3({ subject: "cust_2" }) }), deps());
    expect(other).toMatchObject({ customerId: "cust_1", actorVersion: 2 });
  });
  it("v2 alone keeps working (no regression), including anonymous public access", async () => {
    expect(await resolveCaller(req({ authorization: `Bearer ${v2()}` }), deps())).toMatchObject({ customerId: "cust_1", actorVersion: 2 });
    expect(await resolveCaller(req({ authorization: `Bearer ${v2({ actor_kind: "anonymous", sub: "anonymous:s" })}` }), deps()))
      .toMatchObject({ shop: SHOP, customerId: null, actorVersion: 2 });
  });
  it("v3 header alone (no Authorization) is verified on its own", async () => {
    expect(await resolveCaller(req({ "x-bmai-actor": await v3() }), deps())).toMatchObject({ customerId: "cust_1", actorVersion: 3 });
  });
});

describe("/api/bmai/status declares v3", () => {
  it("actor: 3 and actorVersions [2, 3]", async () => {
    const body = (await (await statusLoader()).json()) as Record<string, unknown>;
    expect(body.actor).toBe(3);
    expect(body.actorVersions).toEqual([2, 3]);
  });
});
