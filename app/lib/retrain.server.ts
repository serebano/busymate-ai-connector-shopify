import prisma from "../db.server";
import { retrainForMerchant } from "./ingest";

/**
 * Training state for the "Store connection" page + the Home checklist, read off
 * the ShopTenant kb* columns (prisma/schema.prisma), and the "Re-train on my
 * store" action, which runs the ingest synchronously and reports the resulting
 * state — never a fabricated "trained".
 */
export interface TrainingState {
  trainedAt: string | null;
  error: string | null;
  counts: { products: number | null; pages: number | null; policies: number | null };
  fetched: { products: number | null; pages: number | null };
  truncated: boolean;
  chars: number | null;
}

type MaybeTrained = {
  kbTrainedAt?: Date | string | null;
  kbError?: string | null;
  kbProducts?: number | null;
  kbPages?: number | null;
  kbPolicies?: number | null;
  kbChars?: number | null;
  kbTruncated?: boolean | null;
  kbProductsTotal?: number | null;
  kbPagesTotal?: number | null;
};

/** Read the training fields off a ShopTenant row (defensive: null row = never trained). */
export function readTrainingState(tenant: unknown): TrainingState {
  const t = (tenant ?? {}) as MaybeTrained;
  const at = t.kbTrainedAt instanceof Date ? t.kbTrainedAt.toISOString() : typeof t.kbTrainedAt === "string" ? t.kbTrainedAt : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    trainedAt: at,
    error: typeof t.kbError === "string" && t.kbError ? t.kbError : null,
    counts: { products: num(t.kbProducts), pages: num(t.kbPages), policies: num(t.kbPolicies) },
    fetched: { products: num(t.kbProductsTotal), pages: num(t.kbPagesTotal) },
    truncated: t.kbTruncated === true,
    chars: num(t.kbChars),
  };
}

export interface RetrainResult {
  ok: boolean;
  error?: string;
  /** Accepted, but a training pass already running will publish it (no failure). */
  queued?: boolean;
  state: TrainingState;
}

/** Re-run the store's knowledge ingest + runtime publish NOW, then report the persisted state. */
export async function runRetrain(shop: string): Promise<RetrainResult> {
  const before = await prisma.shopTenant.findUnique({ where: { shop } });
  if (!before?.bmaiTenantId) {
    return { ok: false, error: "no provisioned tenant for this shop yet", state: readTrainingState(before) };
  }
  const out = await retrainForMerchant(shop);
  const after = await prisma.shopTenant.findUnique({ where: { shop } });
  return { ok: out.ok, error: out.error, queued: Boolean(out.queued), state: readTrainingState(after) };
}
