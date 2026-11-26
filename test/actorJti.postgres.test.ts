/**
 * ECO-03 — the single-use store on REAL Postgres, through the shipped migration: two clients
 * (two replicas) racing the same jti ⇒ exactly one first use; expired rows are swept.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jtiStoreOver } from "../app/mcp/jtiStore";

const databaseUrl = process.env.SHOPIFY_TOKEN_TEST_DATABASE_URL;
const migration = readFileSync(new URL("../prisma/migrations/20261126120000_actor_jti/migration.sql", import.meta.url), "utf8");

describe.skipIf(!databaseUrl)("ActorJti single-use store across replicas (Postgres)", () => {
  const schema = `jti_test_${randomUUID().replaceAll("-", "")}`;
  let admin: PrismaClient;
  let a: PrismaClient;
  let b: PrismaClient;

  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("schema", schema);
    a = new PrismaClient({ datasourceUrl: url.href });
    b = new PrismaClient({ datasourceUrl: url.href });
    for (const stmt of migration.replace(/^\s*--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      await a.$executeRawUnsafe(stmt);
    }
  });

  afterAll(async () => {
    await a?.$disconnect();
    await b?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it("a racing replay on another replica loses; expired rows are swept", async () => {
    const exp = Math.floor(Date.now() / 1000) + 120;
    const onA = jtiStoreOver(a, () => 1);
    const onB = jtiStoreOver(b, () => 1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? onA : onB)("v3:t:c:race", exp)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await onB("v3:t:c:race", exp)).toBe(false);

    await a.$executeRawUnsafe(`INSERT INTO "ActorJti" ("key","expiresAt") VALUES ('dead', now() - interval '1 minute')`);
    const sweeping = jtiStoreOver(a, () => 0);
    expect(await sweeping("v3:t:c:fresh", exp)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    const left = await a.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "ActorJti" WHERE "key" = 'dead'`);
    expect(Number(left[0].n)).toBe(0);
  });
});
