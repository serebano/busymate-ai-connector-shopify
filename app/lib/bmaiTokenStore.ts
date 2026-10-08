import type { Prisma, PrismaClient } from "@prisma/client";
import { BmaiCredentialError, type TokenStore } from "./bmaiToken";

type CredentialDatabase = Pick<Prisma.TransactionClient, "bmaiCredential">;
type Database = Pick<PrismaClient, "bmaiCredential" | "$transaction">;
interface Cipher {
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
}

/** App-owned Postgres only. Each web/worker process shares the same credential lock. */
export function createPrismaTokenStore(db: Database, id: string, cipher: Cipher): TokenStore {
  const scoped = (client: CredentialDatabase): TokenStore => {
    let loadedCiphertext: string | null = null;
    let attempt: Date | null = null;
    return {
      load: async () => {
        const row = await client.bmaiCredential.findUnique({ where: { id } });
        if (row?.refreshPendingAt) {
          throw new BmaiCredentialError("Busymate AI credential renewal was interrupted; restore the connection before retrying");
        }
        loadedCiphertext = row?.refreshToken ?? null;
        return row ? { clientId: row.clientId, refreshToken: cipher.decrypt(row.refreshToken) } : null;
      },
      save: async (value) => {
        if (!attempt || !loadedCiphertext) throw new BmaiCredentialError("Busymate AI credential renewal has no active attempt");
        const refreshToken = cipher.encrypt(value.refreshToken);
        const saved = await client.bmaiCredential.updateMany({
          where: { id, refreshPendingAt: attempt, refreshToken: loadedCiphertext, clientId: value.clientId },
          data: { refreshToken, refreshPendingAt: null },
        });
        if (saved.count !== 1) throw new BmaiCredentialError("Busymate AI credential changed during renewal; restore the connection before retrying");
      },
      beginRefresh: async (value) => {
        const refreshPendingAt = new Date();
        if (loadedCiphertext) {
          const marked = await client.bmaiCredential.updateMany({
            where: { id, refreshPendingAt: null, refreshToken: loadedCiphertext, clientId: value.clientId },
            data: { refreshPendingAt },
          });
          if (marked.count !== 1) throw new BmaiCredentialError("Busymate AI credential changed before renewal; retry the connection");
        } else {
          const refreshToken = cipher.encrypt(value.refreshToken);
          await client.bmaiCredential.create({ data: { id, clientId: value.clientId, refreshToken, refreshPendingAt } });
          loadedCiphertext = refreshToken;
        }
        attempt = refreshPendingAt;
      },
    };
  };
  return {
    ...scoped(db),
    withLock: (run) => db.$transaction(async (tx) => {
      // Bound lock wait and HTTP refresh (10s in bmaiToken) below the 30s transaction.
      // xact locks release on commit/rollback or connection loss, including process exit.
      await tx.$executeRaw`SET LOCAL lock_timeout = '10000ms'`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`busymate-ai-shopify:oauth:${id}`}, 0))::text`;
      // Deliberately use a separate app-DB connection: the attempt marker must
      // COMMIT before OAuth consumes the token and survive rollback/process exit.
      // The advisory transaction owns only the lock, never the credential writes.
      return run(scoped(db));
    }, { maxWait: 10_000, timeout: 30_000 }),
  };
}
