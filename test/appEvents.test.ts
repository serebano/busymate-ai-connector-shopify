import { describe, expect, it, vi } from "vitest";
import {
  APP_EVENTS_URL,
  RESOLUTION_EVENT_HANDLE,
  createAppEventsClient,
  readAppEventsConfig,
  usageIdempotencyKey,
  cumulativeUsageKey,
} from "../app/lib/appEvents";

/**
 * Usage metering under Shopify App Pricing = the App Events API (a billing event
 * per meter; the `event_handle` must equal the meter configured in the Partner
 * pricing plans). Auth is a Dev-Dashboard client-credentials JWT, minted +
 * cached here. Value-blind: credentials come from env by NAME only.
 */
const ENV = { SHOPIFY_APP_EVENTS_CLIENT_ID: "dev-client-id", SHOPIFY_APP_EVENTS_CLIENT_SECRET: "dev-client-secret" } as NodeJS.ProcessEnv;

describe("readAppEventsConfig", () => {
  it("is null without both credentials, and an empty secret is a refusal", () => {
    expect(readAppEventsConfig({})).toBeNull();
    expect(readAppEventsConfig({ SHOPIFY_APP_EVENTS_CLIENT_ID: "x" })).toBeNull();
    expect(readAppEventsConfig({ ...ENV, SHOPIFY_APP_EVENTS_CLIENT_SECRET: "" })).toBeNull();
    expect(readAppEventsConfig(ENV)).toMatchObject({ clientId: "dev-client-id" });
  });
  it("the meter handle + versioned endpoint are pinned", () => {
    expect(RESOLUTION_EVENT_HANDLE).toBe("ai_resolution");
    expect(APP_EVENTS_URL).toBe("https://api.shopify.com/app/2026-07/events");
  });
  it("idempotency keys are ≤64 chars, stable, and unique per (shop, cursor)", () => {
    const k = usageIdempotencyKey("acme.myshopify.com", "cursor-abc");
    expect(k.length).toBeLessThanOrEqual(64);
    expect(k).toBe(usageIdempotencyKey("acme.myshopify.com", "cursor-abc"));
    expect(k).not.toBe(usageIdempotencyKey("acme.myshopify.com", "cursor-abd"));
  });
});

describe("cumulativeUsageKey + Idempotent-Replay", () => {
  it("one key per (shop, cycle, units reported so far), ≤64 chars", () => {
    const k = cumulativeUsageKey("acme.myshopify.com", "2026-11-22T17:36:35Z", 40);
    expect(k.length).toBeLessThanOrEqual(64);
    expect(k).toBe(cumulativeUsageKey("acme.myshopify.com", "2026-11-22T17:36:35Z", 40));
    expect(k).not.toBe(cumulativeUsageKey("acme.myshopify.com", "2026-11-22T17:36:35Z", 41));
    expect(k).not.toBe(cumulativeUsageKey("acme.myshopify.com", "2026-12-22T17:36:35Z", 40));
    expect(k).not.toBe(cumulativeUsageKey("other.myshopify.com", "2026-11-22T17:36:35Z", 40));
  });
  it("a 202 with Idempotent-Replay: true is NOT a new report (held, replay flagged)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("access_token")
        ? new Response(JSON.stringify({ access_token: "jwt", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ success: true }), { status: 202, headers: { "Idempotent-Replay": "true" } }));
    const client = createAppEventsClient({ env: ENV, fetch: fetchMock as unknown as typeof fetch });
    const r = await client.reportUsage({ shopId: "gid://shopify/Shop/1", units: 3, idempotencyKey: "k", timestamp: "2026-11-26T10:00:00Z" });
    expect(r).toMatchObject({ ok: false, replay: true });
  });
});

describe("createAppEventsClient.reportUsage", () => {
  it("mints a client-credentials token once, then POSTs a billing event with value=units", async () => {
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body, auth: (init?.headers as Record<string, string>)?.Authorization });
      if (url === "https://api.shopify.com/auth/access_token") {
        expect(body).toEqual({ client_id: "dev-client-id", client_secret: "dev-client-secret", grant_type: "client_credentials" });
        return new Response(JSON.stringify({ access_token: "jwt-1", expires_in: 3599 }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    });
    const client = createAppEventsClient({ env: ENV, fetch: fetchMock as unknown as typeof fetch, now: () => 1_000_000 });
    const r1 = await client.reportUsage({ shopId: "gid://shopify/Shop/5678", units: 5, idempotencyKey: "k1", timestamp: "2026-09-02T10:00:00Z" });
    const r2 = await client.reportUsage({ shopId: "gid://shopify/Shop/5678", units: 2, idempotencyKey: "k2", timestamp: "2026-09-02T10:01:00Z" });
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    // one mint + two events (token cached)
    expect(calls.map((c) => c.url)).toEqual(["https://api.shopify.com/auth/access_token", APP_EVENTS_URL, APP_EVENTS_URL]);
    expect(calls[1].auth).toBe("Bearer jwt-1");
    expect(calls[1].body).toEqual({
      shop_id: "gid://shopify/Shop/5678",
      event_handle: "ai_resolution",
      timestamp: "2026-09-02T10:00:00Z",
      idempotency_key: "k1",
      attributes: { value: 5 },
    });
  });

  it("fails closed: no credential ⇒ ok:false naming the env vars; a non-2xx ⇒ ok:false with the status", async () => {
    const none = createAppEventsClient({ env: {}, fetch: vi.fn() as unknown as typeof fetch });
    const r = await none.reportUsage({ shopId: "1", units: 1, idempotencyKey: "k", timestamp: "t" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/SHOPIFY_APP_EVENTS_CLIENT_ID/);

    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/auth/access_token")
        ? new Response(JSON.stringify({ access_token: "jwt", expires_in: 3599 }), { status: 200 })
        : new Response(JSON.stringify({ success: false, error: "Forbidden" }), { status: 403 }),
    );
    const c = createAppEventsClient({ env: ENV, fetch: fetchMock as unknown as typeof fetch });
    const bad = await c.reportUsage({ shopId: "1", units: 1, idempotencyKey: "k", timestamp: "t" });
    expect(bad).toEqual({ ok: false, error: "App Events 403: Forbidden" });
  });

  it("refuses a zero/negative unit count (Shopify rejects value=0; reversals are explicit)", async () => {
    const c = createAppEventsClient({ env: ENV, fetch: vi.fn() as unknown as typeof fetch });
    expect(await c.reportUsage({ shopId: "1", units: 0, idempotencyKey: "k", timestamp: "t" })).toMatchObject({ ok: false });
  });

  it("re-mints the token after it expires", async () => {
    let mints = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/access_token")) {
        mints += 1;
        return new Response(JSON.stringify({ access_token: `jwt-${mints}`, expires_in: 60 }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    });
    let t = 0;
    const c = createAppEventsClient({ env: ENV, fetch: fetchMock as unknown as typeof fetch, now: () => t });
    await c.reportUsage({ shopId: "1", units: 1, idempotencyKey: "a", timestamp: "t" });
    t = 120_000; // past the 60 s token lifetime
    await c.reportUsage({ shopId: "1", units: 1, idempotencyKey: "b", timestamp: "t" });
    expect(mints).toBe(2);
  });
});


describe("billing event integer validation", () => {
  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects %s without any token or event request", async (units) => {
    const fetchMock = vi.fn();
    const client = createAppEventsClient({ env: ENV, fetch: fetchMock });
    expect(await client.reportUsage({ shopId: "1", units, idempotencyKey: "k", timestamp: "t" })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
