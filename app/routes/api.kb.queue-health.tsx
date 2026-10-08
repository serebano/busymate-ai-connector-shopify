import prisma from "../db.server";

/** Aggregate liveness only: never expose tenant/shop identities or error payloads. */
export const loader = async () => {
  try {
    const [row] = await prisma.$queryRaw<Array<{ pending: number; overdue: number; expired: number; failed: number; workerFresh: boolean; listenerConnected: boolean }>>`
      SELECT
      (SELECT count(*)::int FROM "KbReingestQueue" WHERE "requested">"completed") AS pending,
      (SELECT count(*)::int FROM "KbReingestQueue" WHERE "requested">"completed" AND "firstPendingAt"<clock_timestamp()-interval '10 minutes') AS overdue,
      (SELECT count(*)::int FROM "KbReingestQueue" WHERE "leaseUntil"<=clock_timestamp()) AS expired,
      (SELECT count(*)::int FROM "KbReingestQueue" WHERE "requested">"completed" AND "lastErrorCode" IS NOT NULL) AS failed,
      EXISTS(SELECT 1 FROM "KbReingestWorkerState" WHERE "id"=1 AND "finishedAt">clock_timestamp()-interval '10 minutes') AS "workerFresh",
      COALESCE((SELECT "listenerConnected" FROM "KbReingestWorkerState" WHERE "id"=1),false) AS "listenerConnected"`;
    const ok = !!row && row.workerFresh && row.listenerConnected && row.overdue === 0 && row.expired === 0 && row.failed === 0;
    return Response.json({ ok, ...row }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: "queue_health_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
};
