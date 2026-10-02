/**
 * Expiring-offline-token audit — READ-ONLY, value-blind counts over the app's
 * `Session` table (SETUP.md §3c; owner item d, busymate-devtools#3995).
 *
 * Public apps created after 2026-04-01 must use EXPIRING offline access tokens;
 * a permanent one (`expires IS NULL`) is rejected by Shopify ("Non-expiring
 * access tokens are no longer accepted") and flagged by the Dev Dashboard
 * ("Deprecated offline token use detected"). This prints counts only — never a
 * token, a shop list is opt-in (`--shops`, domains only):
 *
 *   npm run tokens:audit            # counts
 *   npm run tokens:audit -- --shops # + the shop domains of any PERMANENT session
 *
 * `permanent` MUST be 0. If it is not, run `npm run tokens:cycle` (SETUP §3c) and
 * re-run this audit. Exit 0 = permanent == 0; exit 1 otherwise.
 */
import prisma from "../app/db.server";

const showShops = process.argv.includes("--shops");
if (!process.env.DATABASE_URL) {
  console.error("[audit] missing env DATABASE_URL");
  process.exit(2);
}

const now = new Date();
const offline = { isOnline: false } as const;
const [total, offlineTotal, permanent, noRefreshToken, expiredNow, refreshTokenExpired, online] = await Promise.all([
  prisma.session.count(),
  prisma.session.count({ where: offline }),
  prisma.session.count({ where: { ...offline, expires: null } }),
  prisma.session.count({ where: { ...offline, refreshToken: null } }),
  prisma.session.count({ where: { ...offline, expires: { lt: now } } }),
  prisma.session.count({ where: { ...offline, refreshTokenExpires: { lt: now } } }),
  prisma.session.count({ where: { isOnline: true } }),
]);
const bounds = await prisma.session.aggregate({ where: offline, _min: { expires: true }, _max: { expires: true } });

const report = {
  checkedAt: now.toISOString(),
  sessions: { total, offline: offlineTotal, online },
  offline: {
    permanent,
    noRefreshToken,
    expiredNow,
    refreshTokenExpired,
    expiresMin: bounds._min.expires?.toISOString() ?? null,
    expiresMax: bounds._max.expires?.toISOString() ?? null,
  },
  verdict: permanent === 0 ? "every offline session is an expiring token" : `${permanent} permanent offline session(s) — run npm run tokens:cycle`,
  ...(showShops && permanent > 0
    ? { permanentShops: (await prisma.session.findMany({ where: { ...offline, expires: null }, select: { shop: true } })).map((r) => r.shop) }
    : {}),
};
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
process.exit(permanent === 0 ? 0 : 1);
