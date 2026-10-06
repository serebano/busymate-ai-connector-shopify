/**
 * Ops: re-train (re-publish) one or more shops through the app's OWN training
 * path — `retrainNow` in app/lib/ingest.ts, the same function the merchant's
 * "Re-train on my store" button and the products webhook call. Use it after a
 * platform-side change that needs every trained tenant re-projected (e.g. the
 * 2026-09-02 knowledge `updatedAt` fix), or to train a store without opening the
 * embedded admin.
 *
 *   npm run kb:retrain -- <shop.myshopify.com> [<shop.myshopify.com> ...]
 *
 * Needs the app env (SHOPIFY_API_KEY/SECRET, SHOPIFY_APP_URL, DATABASE_URL,
 * APP_ENCRYPTION_KEY, BMAI_MGMT_* / BMAI_PARTNER_PROOF_SECRET) — on the host,
 * source /etc/busymate-ai-shopify/env as root and `sudo -E -H -u deploy` (SETUP §3c).
 * Prints counts / revision only; exits 1 if any shop failed (value-blind).
 */
import { retrainNow } from "../app/lib/ingest";

async function main(): Promise<number> {
  const shops = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!shops.length) {
    console.error("usage: npm run kb:retrain -- <shop.myshopify.com> [...]");
    return 2;
  }
  let failed = 0;
  for (const shop of shops) {
    const out = await retrainNow(shop);
    console.log(
      JSON.stringify({
        shop,
        ok: out.ok,
        error: out.error ?? null,
        counts: out.counts,
        fetched: out.fetched,
        totalChars: out.totalChars,
        truncated: out.truncated,
        revision: out.revision ?? null,
      }),
    );
    if (!out.ok) failed++;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[kb:retrain] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
