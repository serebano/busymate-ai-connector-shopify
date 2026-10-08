/**
 * The app's DURABLE bmai provisioning credential.
 *
 * The Busymate AI MCP surface (busymate.ai/mcp) authenticates every `tools/call` with a
 * short-lived (1h) OAuth 2.1 access token. A headless server cannot re-run the
 * browser consent every hour, so the durable credential is an OAuth REFRESH TOKEN
 * (rotating) obtained ONCE via the DCR + PKCE authorization-code flow. This provider
 * mints a fresh access token from that refresh token, caches it until just before
 * expiry, and PERSISTS each rotated refresh token (the edge rotates on every
 * refresh — the previous one is revoked) so a restart survives.
 *
 * Env (set on the app host, value-blind):
 *   BMAI_MGMT_CLIENT_ID           — the DCR client_id the refresh token belongs to
 *   BMAI_MGMT_REFRESH_TOKEN       — the SEED refresh token (used once, then the
 *                                   rotated value is read from the store)
 *   BMAI_MGMT_TOKEN               — OPTIONAL static access token (bootstrap/testing);
 *                                   used only when no refresh credential is set
 *
 * A `TokenStore` (Prisma-backed in prod) persists the rotating refresh token; the
 * store ALWAYS wins over the env seed once populated, so the (now-stale) seed is a
 * one-time bootstrap. Secrets are value-blind: never logged or returned.
 *
 */

export interface StoredRefresh {
  clientId: string;
  refreshToken: string;
}

/** Durable store for the rotating refresh token (Prisma in prod; memory in tests). */
export interface TokenStore {
  load: () => Promise<StoredRefresh | null>;
  save: (v: StoredRefresh) => Promise<void>;
  /** Commit an attempt marker before the remote grant; save clears it on success. */
  beginRefresh?: (credential: StoredRefresh) => Promise<void>;
  /** Serialize reload → refresh → save across processes; resolves after commit. */
  withLock?: <T>(run: (store: TokenStore) => Promise<T>) => Promise<T>;
}

export interface TokenProviderDeps {
  /** The MCP base URL (OAuth /token lives at `${mcpUrl}/token`). */
  mcpUrl: string;
  /** OPTIONAL static access token — bootstrap only, when no refresh creds are set. */
  staticToken?: string;
  /** Seed refresh credential from env (used until the store is populated). */
  seedClientId?: string;
  seedRefreshToken?: string;
  /** Durable rotation store. */
  store?: TokenStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Seconds of head-room before expiry to pre-refresh (default 120). */
  skewSeconds?: number;
}

export interface TokenProvider {
  /** Return a valid OAuth access token, minting/refreshing as needed. */
  getAccessToken: () => Promise<string>;
  /**
   * Drop the cached access token (call on a 401 to force a re-mint). Pass the
   * token that was rejected so a fresher one minted meanwhile is kept.
   */
  invalidate: (staleToken?: string) => void;
}

export class BmaiCredentialError extends Error {}

const tokenEndpoint = (mcpUrl: string) => `${mcpUrl.replace(/\/+$/, "")}/token`;

export function createTokenProvider(deps: TokenProviderDeps): TokenProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const skewMs = (deps.skewSeconds ?? 120) * 1000;

  let cached: { token: string; expMs: number } | null = null;
  // Only used without a durable store. A shared store is read on EVERY refresh.
  let current: StoredRefresh | null =
    deps.seedClientId && deps.seedRefreshToken
      ? { clientId: deps.seedClientId, refreshToken: deps.seedRefreshToken }
      : null;
  let hasStoredCredential = false;
  let persistenceFailure: BmaiCredentialError | null = null;

  async function refresh(credential: StoredRefresh) {
    const res = await fetchImpl(tokenEndpoint(deps.mcpUrl), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: credential.clientId,
      }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || typeof json.access_token !== "string" || !json.access_token.trim()
      || typeof json.refresh_token !== "string" || !json.refresh_token.trim()) {
      throw new BmaiCredentialError(
        `refresh_token grant failed (${res.status} ${json.error ?? ""}${
          json.error_description ? ": " + json.error_description : ""
        }) — re-authorize the app (DCR + PKCE) and reseed the Busymate AI refresh token`,
      );
    }
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    return {
      credential: { clientId: credential.clientId, refreshToken: json.refresh_token },
      access: { token: json.access_token, expMs: now() + ttlMs },
    };
  }

  // SINGLE-FLIGHT refresh. The refresh token ROTATES on every grant and the edge
  // treats a second POST of the same token as replay → it REVOKES THE WHOLE TOKEN
  // FAMILY (incident 2026-09-13: two `Promise.all` MCP calls on a cold cache each
  // refreshed independently and killed the shared "mgmt" credential app-wide).
  // Every concurrent caller therefore awaits ONE shared in-flight promise; the
  // grant is posted exactly once per cold/expired cache.
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    if (persistenceFailure) throw persistenceFailure;
    let grantCompleted = false;
    const run = async (store?: TokenStore) => {
      // Never swallow a failed read and fall back to an already-consumed env seed.
      const stored = store ? await store.load() : null;
      if (stored) hasStoredCredential = true;
      if (store && hasStoredCredential && !stored) {
        throw new BmaiCredentialError("Busymate AI stored credential is missing; restore the connection before retrying");
      }
      const credential = stored ?? current;
      if (!credential) {
        if (deps.staticToken) return { token: deps.staticToken, expMs: now() + 60_000 };
        throw new BmaiCredentialError("no Busymate AI credential configured (refresh credential or bootstrap token required)");
      }
      // This marker survives a crash or rollback of the separate advisory-lock transaction.
      await store?.beginRefresh?.(credential);
      const renewed = await refresh(credential);
      grantCompleted = true;
      // The previous credential has been consumed. Persist BEFORE exposing access.
      if (store) await store.save(renewed.credential);
      else current = renewed.credential;
      return renewed.access;
    };
    try {
      const access = deps.store?.withLock
        ? await deps.store.withLock(run)
        : await run(deps.store);
      if (deps.store && grantCompleted) hasStoredCredential = true;
      // A transaction can fail at commit after save resolves; cache only after it commits.
      cached = access;
      return access.token;
    } catch (err) {
      if (grantCompleted && deps.store) {
        // Do not retry the consumed durable token after an uncertain save/commit.
        persistenceFailure = new BmaiCredentialError("Busymate AI credential renewal could not be saved; restore the connection before retrying");
        throw persistenceFailure;
      }
      throw err;
    }
  }

  return {
    invalidate(staleToken?: string) {
      // Token-aware: a caller that got a 401 on token T drops the cache only if T
      // is STILL the cached token — never a fresher one another caller just minted
      // (which would force a needless extra rotation).
      if (staleToken === undefined || cached?.token === staleToken) cached = null;
    },
    async getAccessToken() {
      if (cached && cached.expMs - skewMs > now()) return cached.token;
      if (!inFlight) {
        inFlight = mint().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
