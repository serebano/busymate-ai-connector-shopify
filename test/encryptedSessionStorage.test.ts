import crypto from "node:crypto";
import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptedSessionStorage } from "../app/lib/encryptedSessionStorage";
import { isEncrypted, resetFieldCipherCache } from "../app/lib/fieldCipher";

/**
 * Expiring offline tokens (#2110): the session now carries a REFRESH TOKEN — a
 * long-lived credential that mints new access tokens — so it must be encrypted at
 * rest exactly like the access token, and come back as plaintext on every read
 * path the library uses (loadSession for unauthenticated.admin, findSessionsByShop
 * for webhooks). The inner storage is an in-memory map so we can inspect the
 * ciphertext the database would hold.
 */

// Synthetic opaque values — NOT credentials.
const ACCESS = "example-offline-access-token-not-a-secret";
const REFRESH = "example-refresh-token-not-a-secret";
const EMAIL = "owner@example.test";

type StoredRow = Session & { email?: string | null };

function memoryStorage(): SessionStorage & { rows: Map<string, StoredRow> } {
  const rows = new Map<string, StoredRow>();
  return {
    rows,
    storeSession: async (s) => {
      rows.set(s.id, s);
      return true;
    },
    loadSession: async (id) => rows.get(id),
    deleteSession: async (id) => rows.delete(id),
    deleteSessions: async (ids) => {
      ids.forEach((id) => rows.delete(id));
      return true;
    },
    findSessionsByShop: async (shop) => [...rows.values()].filter((s) => s.shop === shop),
  };
}

function offlineSession(overrides: Partial<Session> = {}): Session {
  return new Session({
    id: "offline_acme.myshopify.com",
    shop: "acme.myshopify.com",
    state: "",
    isOnline: false,
    scope: "read_products",
    accessToken: ACCESS,
    expires: new Date(Date.now() + 60 * 60 * 1000),
    refreshToken: REFRESH,
    refreshTokenExpires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    email: EMAIL,
    ...overrides,
  });
}

describe("encryptedSessionStorage with a key configured", () => {
  const prevKey = process.env.APP_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    resetFieldCipherCache();
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = prevKey;
    resetFieldCipherCache();
  });

  it("encrypts accessToken, refreshToken AND email on the way in", async () => {
    const inner = memoryStorage();
    const storage = encryptedSessionStorage(inner);
    await storage.storeSession(offlineSession());
    const row = inner.rows.get("offline_acme.myshopify.com")!;
    expect(isEncrypted(row.accessToken!)).toBe(true);
    expect(isEncrypted(row.refreshToken!)).toBe(true);
    expect(isEncrypted(row.email!)).toBe(true);
    expect(row.accessToken).not.toContain(ACCESS);
    expect(row.refreshToken).not.toContain(REFRESH);
    // Non-secret columns are untouched (the library reads expiry to decide refresh).
    expect(row.expires).toBeInstanceOf(Date);
    expect(row.refreshTokenExpires).toBeInstanceOf(Date);
  });

  it("loadSession returns plaintext credentials and a real Session (isActive works)", async () => {
    const inner = memoryStorage();
    const storage = encryptedSessionStorage(inner);
    await storage.storeSession(offlineSession());
    const s = await storage.loadSession("offline_acme.myshopify.com");
    expect(s).toBeInstanceOf(Session);
    expect(s!.accessToken).toBe(ACCESS);
    expect(s!.refreshToken).toBe(REFRESH);
    expect((s as StoredRow).email).toBe(EMAIL);
    expect(s!.isActive(undefined, 5 * 60 * 1000)).toBe(true);
  });

  it("findSessionsByShop decrypts every row", async () => {
    const inner = memoryStorage();
    const storage = encryptedSessionStorage(inner);
    await storage.storeSession(offlineSession());
    const [s] = await storage.findSessionsByShop("acme.myshopify.com");
    expect(s.accessToken).toBe(ACCESS);
    expect(s.refreshToken).toBe(REFRESH);
  });

  it("leaves a session without a refresh token untouched (no phantom column)", async () => {
    const inner = memoryStorage();
    const storage = encryptedSessionStorage(inner);
    await storage.storeSession(offlineSession({ refreshToken: undefined, refreshTokenExpires: undefined }));
    const row = inner.rows.get("offline_acme.myshopify.com")!;
    expect(row.refreshToken).toBeUndefined();
    expect(isEncrypted(row.accessToken!)).toBe(true);
  });
});

describe("encryptedSessionStorage without a key (documented dev/CI no-op)", () => {
  const prevKey = process.env.APP_ENCRYPTION_KEY;
  beforeAll(() => {
    delete process.env.APP_ENCRYPTION_KEY;
    resetFieldCipherCache();
  });
  afterAll(() => {
    if (prevKey !== undefined) process.env.APP_ENCRYPTION_KEY = prevKey;
    resetFieldCipherCache();
  });

  it("passes the refresh token through unchanged", async () => {
    const inner = memoryStorage();
    const storage = encryptedSessionStorage(inner);
    await storage.storeSession(offlineSession());
    const row = inner.rows.get("offline_acme.myshopify.com")!;
    expect(row.refreshToken).toBe(REFRESH);
    expect(row.accessToken).toBe(ACCESS);
  });
});


describe("production storage refuses unencrypted sensitive writes", () => {
  it.each([undefined, "invalid-fixture-key"])("never calls inner storage when the production key is unavailable: case %#", (key) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENCRYPTION_KEY", key);
    resetFieldCipherCache();
    try {
      const inner = memoryStorage();
      const store = vi.spyOn(inner, "storeSession");
      const storage = encryptedSessionStorage(inner);
      expect(() => storage.storeSession(offlineSession())).toThrow("valid APP_ENCRYPTION_KEY");
      expect(store).not.toHaveBeenCalled();
      expect(inner.rows.size).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      resetFieldCipherCache();
    }
  });
});
