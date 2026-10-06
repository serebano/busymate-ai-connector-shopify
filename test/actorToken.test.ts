import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveCaller, type ResolveCallerDeps } from "../app/mcp/auth";
import { verifyActorToken } from "../app/mcp/actorToken";

// ── Interop mint (reproduces Busymate AI's signer independently, NOT the SUT's derive) ──
// A byte-for-byte reproduction of
//   v2/apps/agent/agent/lib/supportActorToken.ts::deriveSupportActorSecret
//   + createSupportActorToken
// so the SUT verifying this token is a genuine cross-implementation interop proof.
const MASTER = "test-master-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUV"; // ≥32 bytes
const OTHER_MASTER = "another-master-secret-9876543210-ZYXWVUTSRQPONMLKJI"; // ≥32 bytes
const AUD = "https://shopify.busymate.ai";
const TENANT = "tnt_11111111";
const CONNECTOR = "con_22222222";
const SHOP = "acme.myshopify.com";
const NOW = 1_800_000_000;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function deriveSecret(master: string, tenantId: string, connectorId: string): Buffer {
  return crypto
    .createHmac("sha256", master)
    .update("bmai-support-actor:v2\n")
    .update(tenantId)
    .update("\n")
    .update(connectorId)
    .digest();
}

interface MintOpts {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  master?: string;
  signTenantId?: string;
  signConnectorId?: string;
}

function mint(opts: MintOpts = {}): string {
  const header = { alg: "HS256", typ: "JWT", kid: "bmai-support-v2", ...(opts.header ?? {}) };
  const payload: Record<string, unknown> = {
    iss: "https://busymate.ai",
    aud: AUD,
    sub: "cust_1",
    actor_kind: "identified",
    tenant_id: TENANT,
    connector_id: CONNECTOR,
    support_session_id: "sess_1",
    policy_revision: 1,
    iat: NOW,
    nbf: NOW - 5,
    exp: NOW + 300,
    jti: "jti_1",
    ...(opts.payload ?? {}),
  };
  const h = b64(header);
  const p = b64(payload);
  const signTenant = opts.signTenantId ?? String(payload.tenant_id ?? "");
  const signConnector = opts.signConnectorId ?? String(payload.connector_id ?? "");
  const secret = deriveSecret(opts.master ?? MASTER, signTenant, signConnector);
  const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

function deps(overrides: Partial<ResolveCallerDeps> = {}): ResolveCallerDeps {
  return {
    resolveShop: async (t, c) => (t === TENANT && c === CONNECTOR ? SHOP : null),
    master: MASTER,
    audience: AUD,
    now: NOW,
    headerCallerAllowed: false,
    ...overrides,
  };
}

function req(token: string | null, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return new Request("https://shopify.busymate.ai/mcp", { method: "POST", headers: h });
}

describe("actor-token verification (resolveCaller)", () => {
  it("ACCEPTS a valid Busymate AI-minted actor token → shop from the DB, customerId = sub", async () => {
    const caller = await resolveCaller(req(mint()), deps());
    expect(caller).not.toBeNull();
    expect(caller!.shop).toBe(SHOP); // shop comes from the injected tenant→shop map
    expect(caller!.customerId).toBe("cust_1"); // = payload.sub
    expect(caller!.confirmed).toBe(false);
    expect(caller!.actor).toBe("bmai");
  });

  it("keeps a signed anonymous subject anonymous even with unsigned identity headers", async () => {
    const caller = await resolveCaller(req(mint({ payload: {
      actor_kind: "anonymous", sub: "anonymous:sess_1", confirmed: true,
    } }), { "x-bmai-customer-id": "cust_1", "x-bmai-confirmed": "1" }), deps());
    expect(caller).toMatchObject({ shop: SHOP, customerId: null, confirmed: true, actor: "bmai" });
  });

  it.each([undefined, null, "", "operator", "admin", 1, true])(
    "refuses missing or unsupported signed actor kind %s without header fallback", async (actor_kind) => {
      const token = mint({ payload: { actor_kind } });
      expect(verifyActorToken(token, { master: MASTER, audience: AUD, now: NOW })).toBeNull();
      for (const headerCallerAllowed of [false, true]) {
        expect(await resolveCaller(req(token, { "x-bmai-shop": SHOP }), deps({ headerCallerAllowed }))).toBeNull();
      }
    },
  );

  it.each([undefined, false, "1", 1])("unsigned confirmation cannot promote signed claim %s", async (confirmed) => {
    for (const headerCallerAllowed of [false, true]) {
      const caller = await resolveCaller(
        req(mint({ payload: { confirmed } }), { "x-bmai-confirmed": "1" }),
        deps({ headerCallerAllowed }),
      );
      expect(caller?.actor).toBe("bmai");
      expect(caller?.confirmed).toBe(false);
    }
  });

  it("signed confirmation stays authoritative when an unsigned header contradicts it", async () => {
    const caller = await resolveCaller(req(mint({ payload: { confirmed: true } }), { "x-bmai-confirmed": "0" }), deps());
    expect(caller?.confirmed).toBe(true);
  });

  it("explicit dev header callers keep their separate confirmation behavior", async () => {
    const caller = await resolveCaller(req(null, { "x-bmai-shop": SHOP, "x-bmai-confirmed": "1" }), deps({ headerCallerAllowed: true }));
    expect(caller?.actor).toBe("header");
    expect(caller?.confirmed).toBe(true);
  });

  // ── REJECTS — each a one-field mutation, fail-closed → null ─────────────────
  const rejects: Array<[string, () => Request, Partial<ResolveCallerDeps>?]> = [
    ["wrong master (signed under a different master)", () => req(mint({ master: OTHER_MASTER }))],
    [
      "secret derived for a DIFFERENT connector under the same master",
      () => req(mint({ signConnectorId: "con_ATTACKER" })),
    ],
    ["wrong aud", () => req(mint({ payload: { aud: "https://evil.example" } }))],
    ["wrong iss", () => req(mint({ payload: { iss: "https://evil.example" } }))],
    ["wrong kid", () => req(mint({ header: { kid: "not-the-actor-kid" } }))],
    ["alg:none", () => req(mint({ header: { alg: "none" } }))],
    ["expired (exp <= now)", () => req(mint({ payload: { iat: NOW - 400, nbf: NOW - 405, exp: NOW - 100 } }))],
    ["over-long TTL (exp - iat > 300)", () => req(mint({ payload: { exp: NOW + 400 } }))],
    ["missing sub", () => req(mint({ payload: { sub: undefined } }))],
    ["missing support_session_id", () => req(mint({ payload: { support_session_id: undefined } }))],
    ["missing jti", () => req(mint({ payload: { jti: undefined } }))],
    [
      "tenant/connector pair with NO matching shop row",
      () =>
        req(
          mint({
            payload: { tenant_id: "tnt_unknown", connector_id: "con_unknown" },
            signTenantId: "tnt_unknown",
            signConnectorId: "con_unknown",
          }),
        ),
    ],
  ];

  for (const [label, build, depOverrides] of rejects) {
    it(`REJECTS: ${label}`, async () => {
      const caller = await resolveCaller(build(), deps(depOverrides));
      expect(caller).toBeNull();
    });
  }

  it("REJECTS: tampered payload (signature no longer matches)", async () => {
    const parts = mint().split(".");
    const mutated = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    mutated.sub = "cust_ATTACKER";
    parts[1] = b64(mutated); // re-encode payload but keep the original signature
    const caller = await resolveCaller(req(parts.join(".")), deps());
    expect(caller).toBeNull();
  });

  it("REJECTS: unset master ⇒ no verifier (null)", async () => {
    const caller = await resolveCaller(req(mint()), deps({ master: "" }));
    expect(caller).toBeNull();
  });

  it("REJECTS: short master ⇒ no verifier (null)", async () => {
    const caller = await resolveCaller(req(mint()), deps({ master: "too-short" }));
    expect(caller).toBeNull();
  });

  // ── Legacy header caller gate ───────────────────────────────────────────────
  it("with the header caller OFF, x-bmai-shop alone ⇒ null", async () => {
    const caller = await resolveCaller(req(null, { "x-bmai-shop": SHOP }), deps({ headerCallerAllowed: false }));
    expect(caller).toBeNull();
  });

  it("with the header caller ON (dev/test), x-bmai-shop resolves as a guest header caller", async () => {
    const caller = await resolveCaller(req(null, { "x-bmai-shop": SHOP }), deps({ headerCallerAllowed: true }));
    expect(caller).not.toBeNull();
    expect(caller!.shop).toBe(SHOP);
    expect(caller!.customerId).toBeNull();
    expect(caller!.actor).toBe("header");
  });

  it("a bad actor token is NEVER downgraded to the header path (fail-closed)", async () => {
    // header caller ON, but the bearer peeks as an actor token and fails to verify
    // → must refuse, even though x-bmai-shop is also present.
    const caller = await resolveCaller(
      req(mint({ master: OTHER_MASTER }), { "x-bmai-shop": SHOP }),
      deps({ headerCallerAllowed: true }),
    );
    expect(caller).toBeNull();
  });
});

describe("verifyActorToken (pure verifier)", () => {
  const opts = { master: MASTER, audience: AUD, now: NOW };

  it("returns claims for a valid token", () => {
    const claims = verifyActorToken(mint(), opts);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("cust_1");
    expect(claims!.tenantId).toBe(TENANT);
    expect(claims!.connectorId).toBe(CONNECTOR);
    expect(claims!.supportSessionId).toBe("sess_1");
  });

  it("pins alg at the verifier level (alg:none ⇒ null even if peek were bypassed)", () => {
    expect(verifyActorToken(mint({ header: { alg: "none" } }), opts)).toBeNull();
  });

  it("pins kid at the verifier level", () => {
    expect(verifyActorToken(mint({ header: { kid: "wrong" } }), opts)).toBeNull();
  });

  it("fails closed with an unusable master", () => {
    expect(verifyActorToken(mint(), { ...opts, master: "short" })).toBeNull();
  });
});

// ── #2132: the platform's SIGNED confirm acknowledgement ─────────────────────
// Busymate AI releases a confirm-gated connector call through its approval card and
// then mints the actor token with `confirmed: true` (v2 createSupportActorToken).
// Before this fix the app read only the unsigned x-bmai-confirmed header, which the
// platform never sends, so every approved cancel_order/create_refund answered
// "Confirmation required" (issue #2132, the reviewer's "cancel my order" FAIL).
describe("#2132 signed confirmed claim", () => {
  it("verifyActorToken surfaces confirmed:true from the signed payload", () => {
    const claims = verifyActorToken(mint({ payload: { confirmed: true } }), { master: MASTER, audience: AUD, now: NOW });
    expect(claims?.confirmed).toBe(true);
  });

  it("verifyActorToken reports confirmed:false when the claim is absent or not boolean true", () => {
    expect(verifyActorToken(mint(), { master: MASTER, audience: AUD, now: NOW })?.confirmed).toBe(false);
    expect(verifyActorToken(mint({ payload: { confirmed: "1" } }), { master: MASTER, audience: AUD, now: NOW })?.confirmed).toBe(false);
  });

  it("resolveCaller honours the signed claim with NO x-bmai-confirmed header (the production shape)", async () => {
    const caller = await resolveCaller(req(mint({ payload: { confirmed: true } })), deps());
    expect(caller?.actor).toBe("bmai");
    expect(caller?.confirmed).toBe(true);
  });

  it("resolveCaller stays unconfirmed when the signed claim is false and no header is present", async () => {
    const caller = await resolveCaller(req(mint({ payload: { confirmed: false } })), deps());
    expect(caller?.confirmed).toBe(false);
  });
});


it("MCP transport preserves customer identity and signed confirmation gates before side effects", async () => {
  const handler = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ content: [{ type: "text", text: "fixture completed" }] }));
  const adminForShop = vi.fn(async () => ({}));
  vi.doMock("../app/mcp/auth", () => ({ resolveCaller: (request: Request) => resolveCaller(request, deps()) }));
  vi.doMock("../app/mcp/shopifyAdmin", () => ({ adminForShop }));
  vi.doMock("../app/mcp/tools/registry", async () => {
    const registry = await vi.importActual<typeof import("../app/mcp/tools/registry")>("../app/mcp/tools/registry");
    return { ...registry, toolByName: (name: string) => {
      const tool = registry.toolByName(name);
      return tool ? { ...tool, handler } : undefined;
    } };
  });
  try {
    const { handleMcpRequest } = await import("../app/mcp/route");
    const call = (confirmed: boolean, actor_kind = "identified", name = "apply_discount") => handleMcpRequest(new Request(`${AUD}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${mint({ payload: { confirmed, actor_kind, sub: actor_kind === "anonymous" ? "anonymous:sess_1" : "cust_1" } })}`, "content-type": "application/json", "x-bmai-confirmed": "1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    }));
    const denied = await (await call(false)).json();
    expect(denied.result.structuredContent.requiresConfirm).toBe(true);
    expect(adminForShop).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    for (const name of ["get_order_status", "apply_discount"]) {
      const anonymousDenied = await (await call(true, "anonymous", name)).json();
      expect(anonymousDenied.result.isError).toBe(true);
      expect(anonymousDenied.result.content[0].text).toContain("sign in");
      expect(adminForShop).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
    const permitted = await (await call(true)).json();
    expect(permitted.result.content[0].text).toBe("fixture completed");
    expect(adminForShop).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ shop: SHOP, customerId: "cust_1", confirmed: true });
    const identifiedRead = await (await call(false, "identified", "get_order_status")).json();
    expect(identifiedRead.result.content[0].text).toBe("fixture completed");
    expect(adminForShop).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][1]).toMatchObject({ shop: SHOP, customerId: "cust_1", confirmed: false });
    const anonymousPublic = await (await call(false, "anonymous", "search_products")).json();
    expect(anonymousPublic.result.content[0].text).toBe("fixture completed");
    expect(adminForShop).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[2][1]).toMatchObject({ shop: SHOP, customerId: null, confirmed: false });
  } finally {
    vi.doUnmock("../app/mcp/auth");
    vi.doUnmock("../app/mcp/shopifyAdmin");
    vi.doUnmock("../app/mcp/tools/registry");
  }
});
