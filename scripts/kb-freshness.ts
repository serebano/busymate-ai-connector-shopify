/**
 * Ops + host timer: the knowledge-freshness BACKSTOP (#52). Re-trains every
 * active shop whose knowledge is older than 72 h through the app's ONE training
 * path (`retrainNow`), marks shops Shopify no longer serves (404 admin +
 * storefront) inactive, and logs the run with counts in the KbFreshnessRun ledger.
 * Decisions: app/lib/kbFreshness.ts. Wiring: app/lib/kbFreshness.server.ts.
 *
 *   npm run kb:freshness                     # one run (what the systemd timer does)
 *   npm run kb:freshness -- --dry-run        # what WOULD happen (probes, no writes)
 *   npm run kb:freshness -- --report         # per-shop age + the health verdict, no writes
 *   npm run kb:freshness -- --trigger manual # label the ledger row
 *
 * Env (optional): KB_FRESHNESS_MAX_PER_RUN (30) · KB_FRESHNESS_SPACING_MS (3000) ·
 * KB_FRESHNESS_JITTER_MS (2000) · KB_FRESHNESS_RETRAIN_AFTER_HOURS (72).
 * Exit: 0 run completed with no training failure · 1 a shop failed to train or the
 * run crashed · 2 bad usage. --report exits 1 unless the health verdict is green.
 * Prints shop domains, counts and verdicts only — never a credential.
 */
import { listFreshnessRows, readFreshnessHealth, runFreshnessBackstop } from "../app/lib/kbFreshness.server";
import { ageHours, isActive } from "../app/lib/kbFreshness";

const num = (name: string): number | undefined => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? v : undefined;
};

async function main(argv: string[]): Promise<number> {
  const known = new Set(["--dry-run", "--report", "--trigger"]);
  for (const a of argv) if (a.startsWith("--") && !known.has(a)) { console.error(`unknown flag ${a}`); return 2; }

  if (argv.includes("--report")) {
    const now = new Date();
    for (const r of await listFreshnessRows()) {
      const age = ageHours(r.kbTrainedAt, now);
      console.log(JSON.stringify({
        shop: r.shop, active: isActive(r), state: r.provisionState, inactive: r.inactiveAt ? r.inactiveAt.toISOString() : null,
        trainedAt: r.kbTrainedAt ? r.kbTrainedAt.toISOString() : null, ageHours: age === null ? null : Math.round(age * 10) / 10,
      }));
    }
    const health = await readFreshnessHealth(now);
    console.log(JSON.stringify({ health }));
    return health.verdict === "green" ? 0 : 1;
  }

  const ti = argv.indexOf("--trigger");
  const trigger = ti >= 0 ? argv[ti + 1] : undefined;
  if (ti >= 0 && (!trigger || trigger.startsWith("--"))) { console.error("--trigger needs a value"); return 2; }
  const out = await runFreshnessBackstop({
    dryRun: argv.includes("--dry-run"),
    trigger: trigger ?? "timer",
    maxPerRun: num("KB_FRESHNESS_MAX_PER_RUN"),
    spacingMs: num("KB_FRESHNESS_SPACING_MS"),
    jitterMs: num("KB_FRESHNESS_JITTER_MS"),
    retrainAfterHours: num("KB_FRESHNESS_RETRAIN_AFTER_HOURS"),
  });
  if (out.skipped) { console.log(JSON.stringify({ skipped: out.skipped })); return 0; }
  for (const r of out.summary!.results) console.log(JSON.stringify(r));
  const { results: _r, ...counts } = out.summary!;
  console.log(JSON.stringify({ runId: out.runId, ...counts }));
  return out.summary!.failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[kb:freshness] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
