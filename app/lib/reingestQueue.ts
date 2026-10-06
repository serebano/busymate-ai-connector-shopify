/**
 * Prepared durable retrain boundary; not wired into ingest or webhook routes yet.
 * Persistence must satisfy the atomic contracts below before activation. An
 * in-memory implementation is suitable only for tests, never acknowledgement.
 */
import type { ReingestReason } from "./kbTrain";

export interface ReingestReceipt {
  shop: string;
  webhookId: string;
  reason: Exclude<ReingestReason, "orders">;
}

export interface ReingestLease {
  shop: string;
  token: string;
  generation: number;
  attempt: number;
  expiresAt: Date;
}

export interface DurableReingestStore {
  /**
   * One transaction: deduplicate (shop, webhookId), lock the shop queue row,
   * advance its requested generation and due time only for a NEW receipt.
   * Resolve only after COMMIT. Failure must reject the webhook acknowledgement.
   */
  enqueue(receipt: ReingestReceipt): Promise<"enqueued" | "duplicate" | "inactive">;
  /** Claim a bounded due row atomically, excluding live leases/inactive shops. */
  claim(): Promise<ReingestLease | null>;
  /** DB clock + token/generation + active-shop check, before external publish. */
  owns(lease: ReingestLease): Promise<boolean>;
  /** Renew only an unexpired exact token; never revive an expired lease. */
  renew(lease: ReingestLease): Promise<ReingestLease | null>;
  /**
   * CAS exact token/generation with DB time. Complete only the claimed generation;
   * preserve a newer request arriving in flight. False means stale, never success.
   */
  complete(lease: ReingestLease): Promise<boolean>;
  /** Persist bounded retry metadata with the same CAS; never discard the job. */
  retry(lease: ReingestLease, delayMs: number, errorCode: string): Promise<boolean>;
  /** Cancel pending generations and invalidate the lease transactionally. */
  cancel(shop: string): Promise<void>;
}

/** Called only AFTER HMAC authentication; no raw webhook body is persisted. */
export async function enqueueWebhookReingest(
  store: Pick<DurableReingestStore, "enqueue">,
  input: { shop: string; webhookId: string; reason: ReingestReason },
): Promise<{ scheduled: boolean; reason?: string }> {
  if (input.reason === "orders") return { scheduled: false, reason: "orders are read live" };
  if (!input.shop.trim() || !input.webhookId.trim()) throw new Error("verified webhook binding required");
  const result = await store.enqueue({ shop: input.shop, webhookId: input.webhookId, reason: input.reason });
  if (result === "inactive") return { scheduled: false, reason: "shop is inactive" };
  if (result === "enqueued" || result === "duplicate") return { scheduled: true };
  throw new Error("durable enqueue returned an unknown verdict");
}

/** Bounded exponential retry; invalid attempt counters fail closed. */
export function reingestRetryDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("positive attempt required");
  return Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempt - 1, 9));
}
