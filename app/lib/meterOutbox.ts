/** Internal prepared-batch core. Not connected to meterShop or a billing producer. */
import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { planFor } from "./plans";

type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
export interface PreparedMeterBatch {
  shop: string;
  tenantId: string;
  shopId: string;
  plan: string;
  subscriptionId: string;
  beforeCursor: string | null;
  afterCursor: string;
  units: number;
  /** Validated ledger occurrence range, not this process's current time. */
  occurredFrom: string;
  occurredThrough: string;
  timestamp: string;
  cycleStart: string;
  cycleEnd: string;
  /** Durable eligibility/cycle evidence supplied by the future ledger adapter. */
  evidenceRef: string;
}
interface Payload extends PreparedMeterBatch { idempotencyKey: string }
export interface MeterDelivery {
  id: string;
  shop: string;
  payloadHash: string;
  payload: Payload;
  state: "pending" | "accepted" | "reconciliation";
  leaseToken: string | null;
  leaseUntil: Date | null;
  acceptedAt: Date | null;
}
interface Snapshot { shop: string; plan: string; status: string; subscriptionId: string | null; lastMeteredCursor: string | null; bmaiTenantId: string | null }

export function validatePreparedBatch(batch: PreparedMeterBatch): void {
  for (const key of ["shop", "tenantId", "shopId", "plan", "subscriptionId", "afterCursor", "evidenceRef"] as const) {
    if (typeof batch[key] !== "string" || !batch[key].trim()) throw new Error(`missing ${key}`);
  }
  if (planFor(batch.plan).overageCents === null) throw new Error("paid plan required");
  if (batch.beforeCursor !== null && (typeof batch.beforeCursor !== "string" || !batch.beforeCursor.trim())) throw new Error("invalid before cursor");
  if (batch.afterCursor === batch.beforeCursor) throw new Error("cursor must advance");
  if (!Number.isSafeInteger(batch.units) || batch.units <= 0) throw new Error("positive safe integer units required");
  const times = [batch.cycleStart, batch.occurredFrom, batch.occurredThrough, batch.timestamp, batch.cycleEnd].map(value => typeof value === "string" ? Date.parse(value) : NaN);
  const [start, from, through, stamp, end] = times;
  if (!times.every(Number.isFinite) || start > from || from > through || through >= end || stamp < start || stamp >= end) throw new Error("evidence and timestamp must belong to one proven billing cycle");
}
function freezePayload(batch: PreparedMeterBatch): { payload: Payload; hash: string } {
  validatePreparedBatch(batch);
  // Explicit order and whitelist: unknown caller properties cannot change billing.
  const stable: PreparedMeterBatch = { shop: batch.shop, tenantId: batch.tenantId, shopId: batch.shopId,
    plan: batch.plan, subscriptionId: batch.subscriptionId, beforeCursor: batch.beforeCursor,
    afterCursor: batch.afterCursor, units: batch.units, occurredFrom: batch.occurredFrom,
    occurredThrough: batch.occurredThrough, timestamp: batch.timestamp, cycleStart: batch.cycleStart,
    cycleEnd: batch.cycleEnd, evidenceRef: batch.evidenceRef };
  const hash = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  return { payload: { ...stable, idempotencyKey: `bmai_batch_${hash.slice(0, 48)}` }, hash };
}
async function lockShop(tx: Tx, shop: string): Promise<Snapshot> {
  const rows = await tx.$queryRaw<Snapshot[]>`SELECT b."shop", b."plan", b."status", b."subscriptionId", b."lastMeteredCursor", t."bmaiTenantId" FROM "BillingState" b JOIN "ShopTenant" t ON t."shop"=b."shop" WHERE b."shop"=${shop} FOR UPDATE OF b, t`;
  if (!rows[0]) throw new Error("billing shop unavailable");
  return rows[0];
}
function matches(snapshot: Snapshot, payload: Payload): boolean {
  return snapshot.status === "active" && snapshot.plan === payload.plan && snapshot.subscriptionId === payload.subscriptionId && snapshot.bmaiTenantId === payload.tenantId && snapshot.lastMeteredCursor === payload.beforeCursor;
}

export function createMeterOutbox(db: Database) {
  return {
    async prepare(batch: PreparedMeterBatch): Promise<MeterDelivery> {
      const frozen = freezePayload(batch);
      return db.$transaction(async tx => {
        const snapshot = await lockShop(tx, batch.shop);
        const pending = await tx.$queryRaw<MeterDelivery[]>`SELECT * FROM "MeterDelivery" WHERE "shop"=${batch.shop} AND "state" <> 'accepted'`;
        if (pending[0]) return pending[0]; // Never replace a retry with a newer reader batch.
        const existing = await tx.$queryRaw<MeterDelivery[]>`SELECT * FROM "MeterDelivery" WHERE "shop"=${batch.shop} AND "payloadHash"=${frozen.hash}`;
        if (existing[0]) return existing[0];
        if (!matches(snapshot, frozen.payload)) throw new Error("prepared batch snapshot is stale");
        const id = randomUUID();
        const rows = await tx.$queryRaw<MeterDelivery[]>`INSERT INTO "MeterDelivery"("id","shop","payloadHash","payload") VALUES(${id},${batch.shop},${frozen.hash},${JSON.stringify(frozen.payload)}::jsonb) RETURNING *`;
        return rows[0];
      });
    },
    async claim(shop: string): Promise<MeterDelivery | null> {
      return db.$transaction(async tx => {
        const snapshot = await lockShop(tx, shop);
        const rows = await tx.$queryRaw<MeterDelivery[]>`SELECT * FROM "MeterDelivery" WHERE "shop"=${shop} AND "state"='pending' FOR UPDATE`;
        if (!rows[0]) return null;
        if (!matches(snapshot, rows[0].payload)) throw new Error("pending batch snapshot changed — reconciliation required");
        const token = randomUUID();
        const claimed = await tx.$queryRaw<MeterDelivery[]>`UPDATE "MeterDelivery" SET "leaseToken"=${token}, "leaseUntil"=clock_timestamp()+interval '30 seconds' WHERE "id"=${rows[0].id} AND ("leaseUntil" IS NULL OR "leaseUntil" <= clock_timestamp()) RETURNING *`;
        return claimed[0] ?? null;
      });
    },
    async release(id: string, token: string): Promise<void> {
      if (typeof token !== "string" || !token) throw new Error("delivery claim required");
      await db.$transaction(async tx => {
        await tx.$executeRaw`UPDATE "MeterDelivery" SET "leaseToken"=NULL,"leaseUntil"=NULL WHERE "id"=${id} AND "leaseToken"=${token} AND "state"='pending'`;
      });
    },
    /** Acknowledge API ingestion only. Does not assert processed billing. */
    async accept(id: string, token: string, onAccepted?: (tx: Tx) => Promise<void>): Promise<MeterDelivery> {
      if (typeof token !== "string" || !token) throw new Error("delivery claim required");
      return db.$transaction(async tx => {
        const found = await tx.$queryRaw<MeterDelivery[]>`SELECT * FROM "MeterDelivery" WHERE "id"=${id}`;
        if (!found[0]) throw new Error("unknown delivery");
        const snapshot = await lockShop(tx, found[0].shop);
        const rows = await tx.$queryRaw<MeterDelivery[]>`SELECT * FROM "MeterDelivery" WHERE "id"=${id} FOR UPDATE`;
        const row = rows[0];
        if (row.state !== "pending") return row;
        if (row.leaseToken !== token) throw new Error("delivery claim is stale");
        const state = matches(snapshot, row.payload) ? "accepted" : "reconciliation";
        if (state === "accepted") {
          await tx.$executeRaw`UPDATE "BillingState" SET "lastMeteredCursor"=${row.payload.afterCursor},"updatedAt"=clock_timestamp() WHERE "shop"=${row.shop}`;
          // The caller's ledger commit rides the SAME transaction: an advanced cursor without the
          // batch's sessions in the ledger would let the next run count (and bill) them again.
          if (onAccepted) await onAccepted(tx);
        }
        const accepted = await tx.$queryRaw<MeterDelivery[]>`UPDATE "MeterDelivery" SET "state"=${state},"acceptedAt"=clock_timestamp(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE "id"=${id} RETURNING *`;
        return accepted[0];
      });
    },
  };
}
