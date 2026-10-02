/**
 * Webhook compliance probe — HMAC-signed synthetic deliveries against a RUNNING
 * app server, for a shop whose stored offline session is EXPIRED
 * (owner item d, busymate-devtools#3995; prior art: the #3731 verification).
 *
 * What it does, in order:
 *   1. seeds the app DB with a synthetic ShopTenant row (`provisionState: pending`,
 *      no platform tenant — nothing is held, nothing reaches Busymate AI) and an
 *      EXPIRED offline Session for `probe-expired-<ts>.myshopify.com` (expires one
 *      hour ago, a refresh token Shopify will not honour), written through the
 *      app's own encrypting session storage;
 *   2. for EVERY webhook topic the app subscribes to, re-seeds the expired session
 *      (an uninstall purges it) and POSTs a Shopify-shaped payload, signed with
 *      SHOPIFY_API_SECRET, to `<base>/webhooks/...` — expecting 200 — then the same
 *      body with a bad HMAC — expecting 401;
 *   3. deletes the synthetic rows (BillingState, ShopTenant, Session) — `--keep`
 *      leaves them for inspection.
 *
 * Value-blind: it prints the shop domain, topic, status, latency and timestamps —
 * never the secret, an HMAC, a token or a DATABASE_URL. Exit 0 = every expectation
 * met; exit 1 = at least one miss (listed). Run it on the host with the env
 * sourced (SETUP.md §3c shows the shape), against the live unit or a side server:
 *
 *   npm run webhooks:probe                                  # http://127.0.0.1:3970
 *   npm run webhooks:probe -- --base http://127.0.0.1:3971  # a side server
 *   npm run webhooks:probe -- --keep                        # leave the synthetic rows
 *
 * Env var NAMES: SHOPIFY_API_SECRET, DATABASE_URL, APP_ENCRYPTION_KEY, plus what
 * `app/shopify.server` needs to boot (SHOPIFY_API_KEY, SHOPIFY_APP_URL, SCOPES).
 */
import crypto from "node:crypto";
import "@shopify/shopify-api/adapters/node";
import { Session } from "@shopify/shopify-api";
import prisma from "../app/db.server";
import { sessionStorage } from "../app/shopify.server";

// The library's offline session id (`api.session.getOfflineId`), spelled out here
// so the probe also runs against a host checkout older than 0.1.15 — the app's own
// copy is `offlineSessionId` in app/lib/webhookAuth.ts (pinned by its test).
const offlineSessionId = (s: string) => `offline_${s}`;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (flag("--base") ?? "http://127.0.0.1:3970").replace(/\/$/, "");
const keep = args.includes("--keep");
const shop = flag("--shop") ?? `probe-expired-${Date.now()}.myshopify.com`;

for (const name of ["SHOPIFY_API_SECRET", "DATABASE_URL"]) {
  if (!process.env[name]) {
    console.error(`[probe] missing env ${name}`);
    process.exit(2);
  }
}
const secret = process.env.SHOPIFY_API_SECRET!;

interface Delivery {
  topic: string;
  path: string;
  payload: Record<string, unknown>;
}

/** Every topic in shopify.app.toml (compliance, lifecycle, billing, domains, KB). */
const DELIVERIES: Delivery[] = [
  { topic: "customers/data_request", path: "/webhooks/compliance", payload: { shop_id: 1, shop_domain: shop, customer: { id: 42 }, orders_requested: [] } },
  { topic: "customers/redact", path: "/webhooks/compliance", payload: { shop_id: 1, shop_domain: shop, customer: { id: 42 }, orders_to_redact: [] } },
  { topic: "app/scopes_update", path: "/webhooks/app/scopes_update", payload: { previous: ["read_products"], current: ["read_products", "read_legal_policies"] } },
  { topic: "app_subscriptions/update", path: "/webhooks/app_subscriptions/update", payload: { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Growth", status: "CANCELLED" } } },
  { topic: "domains/create", path: "/webhooks/domains", payload: { id: 1, host: `${shop.replace(".myshopify.com", "")}.example` } },
  { topic: "domains/update", path: "/webhooks/domains", payload: { id: 1, host: `${shop.replace(".myshopify.com", "")}.example` } },
  { topic: "domains/destroy", path: "/webhooks/domains", payload: { id: 1, host: `${shop.replace(".myshopify.com", "")}.example` } },
  { topic: "products/update", path: "/webhooks/kb/products", payload: { id: 1, title: "Probe product" } },
  // Teardown topics last: each purges the session (re-seeded before every delivery anyway).
  { topic: "app/uninstalled", path: "/webhooks/app/uninstalled", payload: { id: 1, domain: shop } },
  { topic: "shop/redact", path: "/webhooks/compliance", payload: { shop_id: 1, shop_domain: shop } },
];

function sign(body: string, s: string): string {
  return crypto.createHmac("sha256", s).update(body, "utf8").digest("base64");
}

const stamp = () => new Date().toISOString();

async function seedTenant(): Promise<void> {
  await prisma.shopTenant.upsert({
    where: { shop },
    create: { shop, provisionState: "pending" },
    update: { provisionState: "pending", bmaiTenantId: null },
  });
}

/** An EXPIRED offline session: token expired 1 h ago, refresh token Shopify will not honour. */
async function seedExpiredSession(): Promise<void> {
  const now = Date.now();
  const session = new Session({
    id: offlineSessionId(shop),
    shop,
    state: "probe",
    isOnline: false,
    scope: "read_products",
    accessToken: `probe-expired-access-token-${crypto.randomBytes(8).toString("hex")}`,
    expires: new Date(now - 60 * 60 * 1000),
    refreshToken: `probe-refresh-token-${crypto.randomBytes(8).toString("hex")}`,
    refreshTokenExpires: new Date(now + 24 * 60 * 60 * 1000),
  });
  await sessionStorage.storeSession(session);
}

async function sessionState(): Promise<"expired" | "missing" | "live"> {
  const row = await prisma.session.findUnique({ where: { id: offlineSessionId(shop) }, select: { expires: true } });
  if (!row) return "missing";
  return row.expires && row.expires.getTime() < Date.now() ? "expired" : "live";
}

async function post(d: Delivery, badHmac: boolean): Promise<{ status: number; ms: number; at: string }> {
  const body = JSON.stringify(d.payload);
  const at = stamp();
  const t0 = performance.now();
  const res = await fetch(`${base}${d.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": d.topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": crypto.randomUUID(),
      "x-shopify-api-version": process.env.SHOPIFY_API_VERSION || "2026-07",
      "x-shopify-hmac-sha256": sign(body, badHmac ? `${secret}-wrong` : secret),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  await res.arrayBuffer();
  return { status: res.status, ms: Math.round(performance.now() - t0), at };
}

interface Row {
  topic: string;
  path: string;
  sessionBefore: string;
  signed: { status: number; ms: number; at: string };
  badHmac: { status: number; ms: number; at: string };
  sessionAfter: string;
  pass: boolean;
}

const rows: Row[] = [];
const misses: string[] = [];
console.log(`[probe] ${stamp()} base=${base} shop=${shop}`);
try {
  await seedTenant();
  for (const d of DELIVERIES) {
    await seedExpiredSession();
    const sessionBefore = await sessionState();
    const signed = await post(d, false);
    const badHmac = await post(d, true);
    const sessionAfter = await sessionState();
    const pass = signed.status === 200 && badHmac.status === 401;
    if (!pass) misses.push(`${d.topic}: signed ${signed.status} (want 200), bad HMAC ${badHmac.status} (want 401)`);
    rows.push({ topic: d.topic, path: d.path, sessionBefore, signed, badHmac, sessionAfter, pass });
    console.log(`[probe] ${signed.at} ${d.topic.padEnd(26)} session=${sessionBefore.padEnd(7)} signed=${signed.status} ${String(signed.ms).padStart(4)}ms  bad-hmac=${badHmac.status} ${String(badHmac.ms).padStart(4)}ms  → ${pass ? "pass" : "FAIL"}`);
  }
} finally {
  if (!keep) {
    await prisma.billingState.deleteMany({ where: { shop } });
    await prisma.shopTenant.deleteMany({ where: { shop } });
    await prisma.session.deleteMany({ where: { shop } });
    const left = await prisma.shopTenant.count({ where: { shop } }) + (await prisma.session.count({ where: { shop } }));
    console.log(`[probe] ${stamp()} cleanup: synthetic rows left = ${left}`);
  } else {
    console.log(`[probe] ${stamp()} --keep: synthetic rows left in place for ${shop}`);
  }
  await prisma.$disconnect();
}

console.log("");
console.log("| Topic | Route | Session before | Signed → status (ms) | Bad HMAC → status (ms) | Session after | Result |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| \`${r.topic}\` | \`${r.path}\` | ${r.sessionBefore} | **${r.signed.status}** (${r.signed.ms} ms, ${r.signed.at}) | **${r.badHmac.status}** (${r.badHmac.ms} ms) | ${r.sessionAfter} | ${r.pass ? "pass" : "FAIL"} |`);
}
console.log("");
console.log(JSON.stringify({ base, shop, passed: rows.filter((r) => r.pass).length, total: rows.length, misses }, null, 2));
process.exit(misses.length ? 1 : 0);
