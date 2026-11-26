/**
 * ECO-03 — the single-use store for actor credential ids (`jti`).
 *
 * A `bmai.actor/3` token (and the guest binding) authorizes ONE `tools/call` of ONE tool. The
 * transport burns its jti here BEFORE any side effect; a second presentation of the same token
 * — on this replica or any other — finds the row and is refused. The store is the app's own
 * Postgres (a unique-key insert), never process memory, so it holds across pods and restarts.
 *
 * FAIL-CLOSED: a database error is a refusal (`false`), never an assumed first use.
 */
import { ACTOR_V3_CLOCK_SKEW_SECONDS } from "./actorTokenV3";

/** `true` ⇔ this is the first use of `key`; `false` ⇔ replay (or the store is unavailable). */
export type ConsumeJti = (key: string, expSeconds: number) => Promise<boolean>;

interface RawDb {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
}

/** One in ~64 burns also sweeps a bounded batch of dead rows (no cron needed). */
const SWEEP_ONE_IN = 64;

export function jtiStoreOver(db: RawDb, random: () => number = Math.random): ConsumeJti {
  return async (key, expSeconds) => {
    if (!key || !Number.isFinite(expSeconds)) return false;
    const expiresAt = new Date((expSeconds + ACTOR_V3_CLOCK_SKEW_SECONDS) * 1000);
    try {
      const inserted = await db.$executeRaw`INSERT INTO "ActorJti" ("key", "expiresAt") VALUES (${key}, ${expiresAt}) ON CONFLICT ("key") DO NOTHING`;
      if (random() * SWEEP_ONE_IN < 1) {
        void db.$executeRaw`DELETE FROM "ActorJti" WHERE "key" IN (SELECT "key" FROM "ActorJti" WHERE "expiresAt" < now() ORDER BY "expiresAt" LIMIT 500)`.catch(() => {});
      }
      return inserted === 1;
    } catch {
      return false;
    }
  };
}

/** Production store: the app's Prisma client (lazy, so importing the transport never opens a DB). */
export const consumeJti: ConsumeJti = async (key, expSeconds) => {
  const { default: prisma } = await import("../db.server");
  return jtiStoreOver(prisma)(key, expSeconds);
};
