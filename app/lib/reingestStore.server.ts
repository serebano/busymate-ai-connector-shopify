import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import type { TrainingPatch } from "./kbTrain";
import type { DurableReingestStore, ReingestLease } from "./reingestQueue";

type Row = { shop: string; leaseToken: string; leaseGeneration: number; attempts: number; leaseUntil: Date };
const lease = (r: Row): ReingestLease => ({ shop: r.shop, token: r.leaseToken, generation: r.leaseGeneration, attempt: r.attempts, expiresAt: r.leaseUntil });

async function boundedTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
    return work(tx);
  }, { maxWait: 2_000, timeout: 5_000 });
}

export const reingestStore: DurableReingestStore = {
  async enqueue(input) {
    const rows = await boundedTransaction((tx) => tx.$queryRaw<Array<{ verdict: "enqueued" | "duplicate" | "inactive" }>>`SELECT kb_reingest_enqueue(${input.shop},${input.webhookId}) AS verdict`);
    if (!rows[0]) throw new Error("durable enqueue did not return a verdict");
    return rows[0].verdict;
  },
  async claim() {
    const rows = await boundedTransaction((tx) => tx.$queryRaw<Row[]>`SELECT * FROM kb_reingest_claim(${randomUUID()})`);
    return rows[0] ? lease(rows[0]) : null;
  },
  async owns(l) {
    const rows = await boundedTransaction((tx) => tx.$queryRaw<Array<{ owned: boolean }>>`SELECT kb_reingest_owns(${l.shop},${l.token},${l.generation}::integer) AS owned`);
    return rows[0]?.owned === true;
  },
  async renew(l) {
    const rows = await boundedTransaction((tx) => tx.$queryRaw<Row[]>`SELECT * FROM kb_reingest_renew(${l.shop},${l.token},${l.generation}::integer)`);
    return rows[0] ? lease(rows[0]) : null;
  },
  async complete(l) {
    const rows = await boundedTransaction((tx) => tx.$queryRaw<Array<{ settled: boolean }>>`SELECT kb_reingest_settle(${l.shop},${l.token},${l.generation}::integer,true,0,'completed') AS settled`);
    return rows[0]?.settled === true;
  },
  async retry(l, delay, code) {
    const rows = await boundedTransaction((tx) => tx.$queryRaw<Array<{ settled: boolean }>>`SELECT kb_reingest_settle(${l.shop},${l.token},${l.generation}::integer,false,${delay}::integer,${code}) AS settled`);
    return rows[0]?.settled === true;
  },
  async cancel(shop) { await boundedTransaction((tx) => tx.$executeRaw`SELECT kb_reingest_cancel(${shop})`); },
};

export async function purgeReingest(shop: string): Promise<void> {
  // Receipt FK cascades. Only the owning GDPR teardown calls this.
  await prisma.$executeRaw`DELETE FROM "KbReingestQueue" WHERE "shop"=${shop}`;
}

export async function requestImmediateReingest(shop: string): Promise<ReingestLease | null> {
  await boundedTransaction((tx) => tx.$queryRaw`SELECT kb_reingest_enqueue(${shop},${`internal:${randomUUID()}`},true)`);
  const rows = await boundedTransaction((tx) => tx.$queryRaw<Row[]>`SELECT * FROM kb_reingest_claim(${randomUUID()},${shop})`);
  return rows[0] ? lease(rows[0]) : null;
}

/** Lock order matches enqueue/cancel: tenant before queue. Cancellation cannot race a late save. */
export async function saveTrainingForLease(l: ReingestLease, patch: TrainingPatch): Promise<void> {
  await boundedTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "shop" FROM "ShopTenant" WHERE "shop"=${l.shop} FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<{ owned: boolean }>>`SELECT kb_reingest_owns(${l.shop},${l.token},${l.generation}::integer) AS owned`;
    if (!rows[0]?.owned) throw new Error("reingest lease lost");
    await tx.shopTenant.updateMany({ where: { shop: l.shop }, data: patch });
  });
}

/** Earliest eligible due/lease expiry, using database time; notification payloads are never state. */
export async function nextReingestDelay(): Promise<number> {
  const rows = await boundedTransaction((tx) => tx.$queryRaw<Array<{ delay: number | null }>>`
    SELECT (EXTRACT(EPOCH FROM (MIN(GREATEST(q."dueAt",COALESCE(q."leaseUntil",clock_timestamp())))-clock_timestamp()))*1000)::double precision AS delay
    FROM "KbReingestQueue" q JOIN "ShopTenant" t USING("shop")
    WHERE q."requested">q."completed" AND t."inactiveAt" IS NULL AND t."provisionState"='published' AND t."bmaiTenantId" IS NOT NULL`);
  return Math.max(0, Math.min(30_000, rows[0]?.delay ?? 30_000));
}

export async function setReingestListenerState(connected: boolean): Promise<void> {
  await boundedTransaction((tx) => tx.$executeRaw`UPDATE "KbReingestWorkerState" SET "listenerConnected"=${connected} WHERE "id"=1`);
}
