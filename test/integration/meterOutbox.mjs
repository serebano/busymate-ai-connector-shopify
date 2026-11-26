// Run explicitly with node --import tsx. No database/default production fallback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createMeterOutbox } from '../../app/lib/meterOutbox.ts';
const url = new URL(process.env.DATABASE_URL || 'https://missing.invalid');
if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55436' || url.pathname !== '/outbox_27') throw new Error('Dedicated disposable outbox_27 on127.0.0.1:55436 required');
const db = new PrismaClient();
const core = createMeterOutbox(db);
const suffix = randomUUID();
const shops = [];
let passed = 0;
async function fixture() {
  const shop = `outbox-${shops.length}-${suffix}.myshopify.com`;
  await db.shopTenant.create({ data: { shop, bmaiTenantId: 'tenant-1' } }); shops.push(shop);
  await db.billingState.create({ data: { shop, status: 'active', plan: 'growth', subscriptionId: 'subscription-1', lastMeteredCursor: 'c0' } });
  return { shop, tenantId: 'tenant-1', shopId: 'gid://shopify/Shop/1', plan: 'growth', subscriptionId: 'subscription-1', beforeCursor: 'c0', afterCursor: 'c1', units: 5,
    occurredFrom: '2026-09-10T00:00:00Z', occurredThrough: '2026-09-11T00:00:00Z', timestamp: '2026-09-11T00:00:00Z', cycleStart: '2026-09-01T00:00:00Z', cycleEnd: '2026-10-01T00:00:00Z', evidenceRef: 'eligible-ledger-proof-1' };
}
async function check(name, run) { await run(); passed++; console.log(`ok ${passed} - ${name}`); }
try {
  const engine = await db.$queryRaw`SELECT version()`;
  assert.match(engine[0].version, /PostgreSQL (16|17|18)\./); // production runs PG18 (efirs)
  await check('overlapping preparation leaves exactly one pending immutable batch (the later one supersedes)', async () => {
    const b = await fixture();
    const [a, c] = await Promise.all([core.prepare(b), core.prepare({ ...b, afterCursor: 'c2', units: 9 })]);
    assert.equal(await db.meterDelivery.count({ where: { shop: b.shop, state: 'pending' } }), 1);
    assert.equal(await db.meterDelivery.count({ where: { shop: b.shop } }), a.id === c.id ? 1 : 2);
    await assert.rejects(db.$executeRaw`UPDATE "MeterDelivery" SET "payload"='{}'::jsonb WHERE "id"=${a.id}`, /immutable/);
  });
  await check('a newer batch supersedes an UNCLAIMED pending one; a claimed one is kept; an identical earlier batch is revived', async () => {
    const b = await fixture();
    const first = await core.prepare(b);
    const newer = await core.prepare({ ...b, afterCursor: 'c2', units: 9 });
    assert.notEqual(newer.id, first.id);
    assert.equal((await db.meterDelivery.findUnique({ where: { id: first.id } })).state, 'superseded');
    const claim = await core.claim(b.shop); assert.equal(claim.id, newer.id);
    assert.equal((await core.prepare({ ...b, afterCursor: 'c3', units: 11 })).id, newer.id); // live lease: untouched
    await core.release(claim.id, claim.leaseToken);
    const revived = await core.prepare(b); // back to the first payload
    assert.equal(revived.id, first.id); assert.equal(revived.state, 'pending');
    assert.equal((await db.meterDelivery.findUnique({ where: { id: newer.id } })).state, 'superseded');
    assert.equal(await db.meterDelivery.count({ where: { shop: b.shop, state: 'pending' } }), 1);
  });
  await check('a reconciliation row is never superseded (metering stays stopped for a human)', async () => {
    const b = await fixture(); await core.prepare(b); const claim = await core.claim(b.shop);
    await db.billingState.update({ where: { shop: b.shop }, data: { plan: 'scale' } });
    assert.equal((await core.accept(claim.id, claim.leaseToken)).state, 'reconciliation');
    await db.billingState.update({ where: { shop: b.shop }, data: { plan: 'growth' } });
    const again = await core.prepare({ ...b, afterCursor: 'c2', units: 9 });
    assert.equal(again.id, claim.id); assert.equal(again.state, 'reconciliation');
  });
  await check('accept runs the ledger commit in the SAME transaction (both or neither)', async () => {
    const b = await fixture(); await core.prepare(b); const claim = await core.claim(b.shop);
    await assert.rejects(core.accept(claim.id, claim.leaseToken, async () => { throw new Error('synthetic ledger failure'); }), /synthetic ledger failure/);
    assert.equal((await db.billingState.findUnique({ where: { shop: b.shop } })).lastMeteredCursor, 'c0');
    assert.equal((await db.meterDelivery.findUnique({ where: { id: claim.id } })).state, 'pending');
    const done = await core.accept(claim.id, claim.leaseToken, (tx) => tx.meteredResolution.createMany({ data: [{ tenantId: `t-${b.shop}`, sessionId: 's1', occurredAt: new Date('2026-09-10T00:00:00Z') }] }));
    assert.equal(done.state, 'accepted');
    assert.equal((await db.billingState.findUnique({ where: { shop: b.shop } })).lastMeteredCursor, 'c1');
    assert.equal(await db.meteredResolution.count({ where: { tenantId: `t-${b.shop}` } }), 1);
    await db.meteredResolution.deleteMany({ where: { tenantId: `t-${b.shop}` } });
  });
  await check('one lease owner; takeover retains payload and rejects old owner', async () => {
    const b = await fixture(); await core.prepare(b);
    const claims = await Promise.all([core.claim(b.shop), core.claim(b.shop)]);
    assert.equal(claims.filter(Boolean).length, 1); const first = claims.find(Boolean);
    await db.$executeRaw`UPDATE "MeterDelivery" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE "id"=${first.id}`;
    const second = await core.claim(b.shop); assert.deepEqual(second.payload, first.payload);
    assert.notEqual(second.leaseToken, first.leaseToken);
    await assert.rejects(core.accept(first.id, first.leaseToken), /stale/);
    await assert.rejects(core.accept(first.id, null), /claim required/);
  });
  await check('API accepted then DB failure retries exact payload and atomically advances once', async () => {
    const b = await fixture(); const prepared = await core.prepare(b); const first = await core.claim(b.shop);
    // Synthetic transport accepts exactly the frozen request; no Shopify API call.
    const acceptedPayload = JSON.stringify(first.payload);
    await db.$executeRawUnsafe(`CREATE FUNCTION outbox_27_fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cursor write failure'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER outbox_27_fail_cursor BEFORE UPDATE OF "lastMeteredCursor" ON "BillingState" FOR EACH ROW EXECUTE FUNCTION outbox_27_fail_cursor()`);
    try { await assert.rejects(core.accept(first.id, first.leaseToken), /synthetic cursor write failure/); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER outbox_27_fail_cursor ON "BillingState"'); await db.$executeRawUnsafe('DROP FUNCTION outbox_27_fail_cursor()'); }
    assert.equal((await db.billingState.findUnique({ where: { shop: b.shop } })).lastMeteredCursor, 'c0');
    assert.equal((await db.meterDelivery.findUnique({ where: { id: first.id } })).state, 'pending');
    const pending = await core.prepare({ ...b, afterCursor: 'c999', units: 999 }); assert.equal(pending.id, prepared.id);
    await core.release(first.id, first.leaseToken); const retry = await core.claim(b.shop);
    assert.equal(JSON.stringify(retry.payload), acceptedPayload);
    const done = await core.accept(retry.id, retry.leaseToken); assert.equal(done.state, 'accepted'); assert.ok(done.acceptedAt);
    assert.equal((await db.billingState.findUnique({ where: { shop: b.shop } })).lastMeteredCursor, 'c1');
    assert.equal((await core.accept(retry.id, retry.leaseToken)).state, 'accepted');
    assert.equal((await core.prepare(b)).id, done.id);
    await assert.rejects(core.prepare({ ...b, afterCursor: 'c2' }), /stale/);
  });
  await check('plan change after send records reconciliation without cursor advancement', async () => {
    const b = await fixture(); await core.prepare(b); const claim = await core.claim(b.shop);
    await db.billingState.update({ where: { shop: b.shop }, data: { plan: 'free' } });
    assert.equal((await core.accept(claim.id, claim.leaseToken)).state, 'reconciliation');
    assert.equal((await db.billingState.findUnique({ where: { shop: b.shop } })).lastMeteredCursor, 'c0');
    assert.equal(await core.claim(b.shop), null);
  });
  await check('tenant rebind or cursor snapshot change refuses delivery before send', async () => {
    const b = await fixture(); await core.prepare(b);
    await db.shopTenant.update({ where: { shop: b.shop }, data: { bmaiTenantId: 'tenant-other' } });
    await assert.rejects(core.claim(b.shop), /snapshot changed/);
    await db.shopTenant.update({ where: { shop: b.shop }, data: { bmaiTenantId: 'tenant-1' } });
    await db.billingState.update({ where: { shop: b.shop }, data: { lastMeteredCursor: 'new-cycle' } });
    await assert.rejects(core.claim(b.shop), /snapshot changed/);
  });
  console.log(`PASS ${passed}/${passed} PostgreSQL delivery scenarios; no live charges`);
} finally {
  await db.shopTenant.deleteMany({ where: { shop: { in: shops } } });
  await db.$disconnect();
}
