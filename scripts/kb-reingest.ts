/** Event-woken durable worker; systemd restarts its dedicated LISTEN session. */
import prisma from "../app/db.server";
import { reingestStore, nextReingestDelay, setReingestListenerState } from "../app/lib/reingestStore.server";
import { runReingestAttempt } from "../app/lib/reingestProcess.server";

import { createReingestWake } from "../app/lib/reingestWake";
import { listenReingest } from "../app/lib/reingestListener.mjs";

async function drain(signal: AbortSignal) {
  await prisma.$executeRaw`UPDATE "KbReingestWorkerState" SET "startedAt"=clock_timestamp() WHERE "id"=1`;
  let claimed = 0, failed = 0;
  const stopAt = Date.now() + 240_000;
  while (!signal.aborted && claimed < 4 && Date.now() < stopAt) {
    const lease = await reingestStore.claim();
    if (!lease) break;
    claimed++;
    if (!(await runReingestAttempt(lease)).ok) failed++;
  }
  // Keep dedup receipts for 30 days; late replay can only request another refresh.
  // Small bounded batches avoid one large deletion on the app database.
  await prisma.$executeRaw`DELETE FROM "KbReingestReceipt" WHERE ("shop","webhookId") IN (SELECT "shop","webhookId" FROM "KbReingestReceipt" WHERE "receivedAt"<clock_timestamp()-interval '30 days' ORDER BY "receivedAt" LIMIT 1000)`;
  await prisma.$executeRaw`UPDATE "KbReingestWorkerState" SET "finishedAt"=clock_timestamp(),"claimed"=${claimed},"failed"=${failed} WHERE "id"=1`;
  console.log(JSON.stringify({ claimed, failed })); // aggregate only; no shop or provider text
}
async function main() {
  if (process.argv.length > 2) throw new Error("kb:reingest takes no arguments");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("app database is required");
  const controller = new AbortController();
  const wake = createReingestWake({ drain: () => drain(controller.signal), nextDelay: nextReingestDelay });
  const stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  wake.wake(); // Durable fallback also runs while the listener is reconnecting.
  try {
    await listenReingest({ connection: { connectionString }, wake: wake.wake, signal: controller.signal, status: setReingestListenerState });
  } finally {
    await wake.stop();
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  }
}
main().catch(() => { console.error("knowledge worker failed; pending work retained"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
