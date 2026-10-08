import { PrismaClient } from "@prisma/client";
import { createTokenProvider } from "../../app/lib/bmaiToken";
import { createPrismaTokenStore } from "../../app/lib/bmaiTokenStore";

const db = new PrismaClient({ datasourceUrl: process.env.SHOPIFY_TOKEN_TEST_DATABASE_URL });
const cipher = { encrypt: (s: string) => `test:${s}`, decrypt: (s: string) => s.slice(5) };
const provider = createTokenProvider({
  mcpUrl: process.env.SHOPIFY_TOKEN_TEST_ISSUER!,
  store: createPrismaTokenStore(db, "mgmt", cipher),
  seedClientId: "test-client",
  seedRefreshToken: "stale-env-seed",
});
process.on("message", async (message: { id: number; invalidate?: boolean }) => {
  try {
    if (message.invalidate) provider.invalidate();
    const token = await provider.getAccessToken();
    process.send?.({ id: message.id, token });
  } catch (err) {
    process.send?.({ id: message.id, error: err instanceof Error ? err.message : String(err) });
  }
});
process.send?.({ ready: true });
