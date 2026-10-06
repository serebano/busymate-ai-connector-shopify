import type { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { decryptField, encryptField } from "./fieldCipher";

/**
 * A SessionStorage decorator that encrypts sensitive Shopify session columns AT
 * REST — the offline `accessToken` (a bearer credential to the store's Admin API),
 * the `refreshToken` (the long-lived credential that mints new access tokens under
 * expiring offline tokens, #2110) and the staff `email` (PII) — while delegating
 * persistence to any underlying storage (PrismaSessionStorage in prod).
 * Encryption happens on the way IN (storeSession) and decryption on the way OUT
 * (loadSession/findSessionsByShop), so every consumer sees plaintext and only the
 * database holds ciphertext.
 *
 * Every reader goes through this decorator: the library's token-exchange and
 * refresh paths, and `app/mcp/shopifyAdmin.ts` via `unauthenticated.admin(shop)`.
 * With no `APP_ENCRYPTION_KEY` configured the field cipher is a transparent no-op
 * only outside production. Production refuses sensitive writes before inner storage.
 */

type SessionLike = Session & {
  accessToken?: string;
  refreshToken?: string;
  email?: string | null;
};

/** Shallow clone preserving the Session prototype, then override string fields. */
function cloneWith(session: Session, patch: Partial<SessionLike>): Session {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(session)), session);
  Object.assign(clone, patch);
  return clone as Session;
}

function transform(session: Session, fn: (v: string) => string): Session {
  const s = session as SessionLike;
  const patch: Partial<SessionLike> = {};
  if (s.accessToken) patch.accessToken = fn(s.accessToken);
  if (s.refreshToken) patch.refreshToken = fn(s.refreshToken);
  if (s.email) patch.email = fn(s.email);
  return Object.keys(patch).length ? cloneWith(session, patch) : session;
}

const encryptSession = (s: Session) => transform(s, encryptField);
const decryptSession = (s: Session) => transform(s, decryptField);

export function encryptedSessionStorage(inner: SessionStorage): SessionStorage {
  return {
    storeSession: (session) => inner.storeSession(encryptSession(session)),
    loadSession: async (id) => {
      const s = await inner.loadSession(id);
      return s ? decryptSession(s) : s;
    },
    deleteSession: (id) => inner.deleteSession(id),
    deleteSessions: (ids) => inner.deleteSessions(ids),
    findSessionsByShop: async (shop) => (await inner.findSessionsByShop(shop)).map(decryptSession),
  };
}
