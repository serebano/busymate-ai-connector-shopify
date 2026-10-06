/** Private worker child. Input travels over its parent's IPC channel, never argv. */
import prisma from "../app/db.server";
import { trainShopUnderLease } from "../app/lib/ingest";
import type { ReingestLease } from "../app/lib/reingestQueue";

if (!process.send) throw new Error("reingest attempt requires parent IPC");
process.once("message", async (raw: ReingestLease) => {
  try {
    if (!raw || typeof raw.shop !== "string" || typeof raw.token !== "string" || !Number.isSafeInteger(raw.generation)) throw new Error("invalid lease");
    const out = await trainShopUnderLease(raw.shop, raw);
    process.send?.(out, async () => { await prisma.$disconnect(); process.exit(0); });
  } catch {
    await prisma.$disconnect();
    process.exit(1);
  }
});
