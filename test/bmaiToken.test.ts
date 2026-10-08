import { describe, expect, it, vi } from "vitest";
import { createTokenProvider, BmaiCredentialError, type StoredRefresh, type TokenStore } from "../app/lib/bmaiToken";

// The durable provisioning credential: a rotating OAuth refresh token minted into a
// short-lived access token, cached until near-expiry, with each rotation persisted.

function memStore(initial: StoredRefresh | null = null): TokenStore & { value: StoredRefresh | null } {
  let value = initial;
  return {
    get value() { return value; },
    load: async () => value,
    save: async (v) => { value = v; },
  };
}

function tokenResponse(access: string, refresh: string, expires_in = 3600) {
  return { ok: true, status: 200, json: async () => ({ access_token: access, refresh_token: refresh, expires_in, token_type: "Bearer" }) } as unknown as Response;
}

describe("bmai durable token provider", () => {
  it("mints via refresh_token grant, caches until near expiry, then re-refreshes", async () => {
    let t = 1_000_000;
    const now = () => t;
    const fetchImpl = vi.fn(async () => tokenResponse("access-1", "refresh-2", 3600));
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp",
      seedClientId: "cid", seedRefreshToken: "refresh-1",
      fetchImpl: fetchImpl as unknown as typeof fetch, now, skewSeconds: 120,
    });
    expect(await p.getAccessToken()).toBe("access-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // within TTL - skew: served from cache (no new fetch)
    t += 3000 * 1000; // +3000s < 3600-120
    expect(await p.getAccessToken()).toBe("access-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // past the skew window: re-refresh
    t += 500 * 1000;
    await p.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // the token endpoint + grant were correct
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://busymate.ai/mcp/token");
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=refresh-1");
  });

  it("PERSISTS the rotated refresh token to the store (store wins over the seed)", async () => {
    const store = memStore(null);
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls++; return tokenResponse(`access-${calls}`, `refresh-next-${calls}`, 3600); });
    let t = 0;
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp/",
      seedClientId: "cid", seedRefreshToken: "refresh-seed",
      store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t, skewSeconds: 0,
    });
    await p.getAccessToken();
    expect(store.value).toEqual({ clientId: "cid", refreshToken: "refresh-next-1" });
    // next refresh uses the STORED (rotated) token, not the seed
    t += 4000 * 1000;
    await p.getAccessToken();
    const [, init2] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(String(init2.body)).toContain("refresh_token=refresh-next-1");
  });

  it("a populated store OVERRIDES a stale env seed", async () => {
    const store = memStore({ clientId: "cid", refreshToken: "stored-rt" });
    const fetchImpl = vi.fn(async () => tokenResponse("a", "b"));
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp",
      seedClientId: "cid", seedRefreshToken: "stale-seed-rt",
      store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0,
    });
    await p.getAccessToken();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("refresh_token=stored-rt");
  });

  it("reloads another process's rotation before the next grant", async () => {
    const store = memStore({ clientId: "cid", refreshToken: "refresh-1" });
    const fetchImpl = vi.fn(async () => tokenResponse("access", "refresh-2"));
    const p = createTokenProvider({ mcpUrl: "https://busymate.ai/mcp", store, fetchImpl: fetchImpl as typeof fetch });
    await p.getAccessToken();
    await store.save({ clientId: "cid", refreshToken: "worker-rotated" });
    p.invalidate();
    await p.getAccessToken();
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("worker-rotated");
  });

  it("does not use the env seed when the durable read fails", async () => {
    const fetchImpl = vi.fn();
    const store = { load: vi.fn().mockRejectedValue(new Error("database unavailable")), save: vi.fn() };
    const p = createTokenProvider({ mcpUrl: "https://busymate.ai/mcp", store, seedClientId: "cid", seedRefreshToken: "stale-seed", fetchImpl });
    await expect(p.getAccessToken()).rejects.toThrow("database unavailable");
    await expect(p.getAccessToken()).rejects.toThrow("database unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.load).toHaveBeenCalledTimes(2);
  });

  it("does not call OAuth when committing the attempt marker fails", async () => {
    const store = memStore({ clientId: "cid", refreshToken: "refresh-1" });
    store.beginRefresh = async () => { throw new Error("attempt commit failed"); };
    const fetchImpl = vi.fn();
    const p = createTokenProvider({ mcpUrl: "https://busymate.ai/mcp", store, fetchImpl });
    await expect(p.getAccessToken()).rejects.toThrow("attempt commit failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, "", 123])("does not save the old credential when a success response omits a valid rotated refresh token: %s", async (refreshToken) => {
    const store = memStore({ clientId: "cid", refreshToken: "consumed-after-grant" });
    const save = vi.spyOn(store, "save");
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: "must-not-escape", refresh_token: refreshToken }) }) as Response);
    const p = createTokenProvider({ mcpUrl: "https://busymate.ai/mcp", store, fetchImpl });
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(BmaiCredentialError);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not reseed after a previously populated durable credential disappears", async () => {
    const store = memStore({ clientId: "cid", refreshToken: "refresh-1" });
    const fetchImpl = vi.fn(async () => tokenResponse("access", "refresh-2"));
    const p = createTokenProvider({ mcpUrl: "https://busymate.ai/mcp", store, seedClientId: "cid", seedRefreshToken: "stale-seed", fetchImpl: fetchImpl as typeof fetch });
    await p.getAccessToken();
    store.load = async () => null;
    p.invalidate();
    await expect(p.getAccessToken()).rejects.toThrow("stored credential is missing");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["save", "commit"])("withholds access and avoids replay after a %s failure", async (failure) => {
    const store = memStore({ clientId: "cid", refreshToken: "refresh-1" });
    if (failure === "save") store.save = async () => { throw new Error("save unavailable"); };
    else store.withLock = async (run) => { await run(store); throw new Error("commit unavailable"); };
    const fetchImpl = vi.fn(async () => tokenResponse("must-not-escape", "refresh-2"));
    const p = createTokenProvider({ mcpUrl: "https://busymate.ai/mcp", store, fetchImpl: fetchImpl as typeof fetch });
    await expect(p.getAccessToken()).rejects.toThrow("could not be saved");
    await expect(p.getAccessToken()).rejects.toThrow("could not be saved");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to a static bootstrap token when no refresh creds are set", async () => {
    const fetchImpl = vi.fn();
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp", staticToken: "boot-token",
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0,
    });
    expect(await p.getAccessToken()).toBe("boot-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Regression for the 2026-09-13 incident: two concurrent callers on a cold cache
  // each posted the SAME refresh token; the edge read that as replay and revoked
  // the whole token family. N concurrent callers must produce exactly ONE grant.
  it("COALESCES concurrent refreshes: N cold-cache callers → exactly 1 refresh grant", async () => {
    const store = memStore(null);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => { await gate; return tokenResponse("access-1", "refresh-2", 3600); });
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp", seedClientId: "cid", seedRefreshToken: "refresh-1",
      store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0,
    });
    const callers = Promise.all(Array.from({ length: 8 }, () => p.getAccessToken()));
    await Promise.resolve(); // let every caller reach the (single) in-flight refresh
    release();
    const tokens = await callers;
    expect(tokens).toEqual(Array(8).fill("access-1"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.value).toEqual({ clientId: "cid", refreshToken: "refresh-2" });
    // a later cold refresh uses the ROTATED token exactly once more
    p.invalidate();
    await Promise.all([p.getAccessToken(), p.getAccessToken()]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init2] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(String(init2.body)).toContain("refresh_token=refresh-2");
  });

  it("a failed in-flight refresh rejects every waiter and clears the slot for a retry", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1
      ? ({ ok: false, status: 503, json: async () => ({ error: "temporarily_unavailable" }) } as unknown as Response)
      : tokenResponse("access-ok", "refresh-2")));
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp", seedClientId: "cid", seedRefreshToken: "refresh-1",
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0,
    });
    const results = await Promise.allSettled([p.getAccessToken(), p.getAccessToken(), p.getAccessToken()]);
    expect(results.every((r) => r.status === "rejected" && r.reason instanceof BmaiCredentialError)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await p.getAccessToken()).toBe("access-ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("invalidate(staleToken) keeps a FRESHER cached token another caller already minted", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls++; return tokenResponse(`access-${calls}`, `refresh-${calls + 1}`); });
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp", seedClientId: "cid", seedRefreshToken: "refresh-1",
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0,
    });
    const first = await p.getAccessToken(); // access-1
    p.invalidate(first);
    const second = await p.getAccessToken(); // access-2 (a legitimate re-mint)
    p.invalidate(first); // a late 401 on the OLD token must NOT drop access-2
    expect(await p.getAccessToken()).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws a clear re-authorize error when the refresh chain is revoked", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "refresh token already used (rotated) — chain revoked" }) }) as unknown as Response);
    const p = createTokenProvider({
      mcpUrl: "https://busymate.ai/mcp", seedClientId: "cid", seedRefreshToken: "revoked",
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0,
    });
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(BmaiCredentialError);
  });

  it("throws when NO credential of any kind is configured", async () => {
    const p = createTokenProvider({ mcpUrl: "https://busymate.ai/mcp", now: () => 0 });
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(BmaiCredentialError);
  });
});
