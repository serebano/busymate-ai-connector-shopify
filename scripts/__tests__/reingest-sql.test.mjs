import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { listenReingest } from '../../app/lib/reingestListener.mjs';

const candidates=['/opt/homebrew/opt/postgresql@18/bin','/opt/homebrew/opt/postgresql/bin','/usr/local/opt/postgresql/bin'];
if(existsSync('/usr/lib/postgresql')) for(const v of readdirSync('/usr/lib/postgresql')) candidates.push(`/usr/lib/postgresql/${v}/bin`);
const bin=candidates.find(p=>['initdb','pg_ctl','psql'].every(f=>existsSync(join(p,f))));

test('exact queue SQL survives restart, contention, retry and stale completion',async()=>{
 assert.ok(bin,'isolated PostgreSQL binaries required; missing is not a pass');
 const root=mkdtempSync(join(tmpdir(),'bmai-reingest-')),data=join(root,'data'),socket=join(root,'socket');mkdirSync(socket);
 const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:root};
 const run=(cmd,args,input)=>execFileSync(join(bin,cmd),args,{env,input,encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']});
 const args=['-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-h',socket,'-U','fixture','-d','postgres'];
 const sql=text=>run('psql',args,text).trim();
 const parallel=text=>new Promise((res,rej)=>{const p=spawn(join(bin,'psql'),args,{env,stdio:['pipe','pipe','pipe'],timeout:30000});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',rej);p.on('exit',code=>code===0?res(out.trim()):rej(Error(err)));p.stdin.end(text);});
 const start=()=>run('pg_ctl',['-D',data,'-l',join(root,'pg.log'),'-o',`-F -c listen_addresses='' -k ${socket}`,'-w','start']);
 let started=false;const stopListening=new globalThis.AbortController();let listening;
 try{
  run('initdb',['-D',data,'--auth=trust','--username=fixture','--no-locale','--encoding=UTF8']);start();started=true;
  sql('CREATE TABLE "ShopTenant"("shop" TEXT PRIMARY KEY,"inactiveAt" TIMESTAMPTZ,"inactiveReason" TEXT,"provisionState" TEXT,"bmaiTenantId" TEXT);');
  sql(readFileSync(new URL('../../prisma/migrations/20261006053000_kb_reingest_queue/migration.sql',import.meta.url),'utf8'));
  let wakes=0;
  const until=async predicate=>{for(let i=0;i<300&&!predicate();i++)await wait(10);assert.ok(predicate(),'bounded notification/rejoin wait');};
  listening=listenReingest({connection:{host:socket,user:'fixture',database:'postgres',password:'synthetic-unused'},wake:()=>{wakes++;},signal:stopListening.signal,retryMs:20});
  await until(()=>wakes===1); // LISTEN ready must reread even without a notification.
  const shop='fixture.myshopify.com' ,token='synthetic-lease-token-11111',other='synthetic-lease-token-22222';
  sql(`INSERT INTO "ShopTenant"("shop","provisionState","bmaiTenantId") VALUES('${shop}','published','synthetic-tenant');`);
  assert.equal(sql(`SELECT kb_reingest_enqueue('${shop}','delivery1');`),'enqueued');
  await until(()=>wakes===2); // Committed enqueue wakes the real production listener.
  assert.equal(sql(`SELECT kb_reingest_enqueue('${shop}','delivery1');`),'duplicate');
  assert.equal(sql('SELECT "requested" FROM "KbReingestQueue";'),'1');
  run('pg_ctl',['-D',data,'-w','stop','-m','fast']);started=false;start();started=true;
  await until(()=>wakes>=3); // Real server restart reconnects and authoritatively wakes again.
  assert.equal(sql('SELECT count(*) FROM "KbReingestReceipt";'),'1','receipt survives database restart');
  sql(`UPDATE "KbReingestQueue" SET "dueAt"=clock_timestamp()-interval '1 second';`);
  const claims=await Promise.all([parallel(`SELECT count(*) FROM kb_reingest_claim('${token}');`),parallel(`SELECT count(*) FROM kb_reingest_claim('${other}');`)]);
  assert.deepEqual(claims.sort(),['0','1'],'only one concurrent claimant');
  const winner=sql('SELECT "leaseToken" FROM "KbReingestQueue";');
  assert.equal(sql(`SELECT kb_reingest_settle('${shop}','wrong-token',1,true,0,'completed');`),'f');
  assert.equal(sql(`SELECT kb_reingest_enqueue('${shop}','delivery2',true);`),'enqueued');
  assert.equal(sql(`SELECT kb_reingest_settle('${shop}','${winner}',1,true,0,'completed');`),'t');
  assert.equal(sql('SELECT "requested"||\'/\'||"completed" FROM "KbReingestQueue";'),'2/1','new generation survives old completion');
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_claim('${token}');`),'1');
  sql(`UPDATE "KbReingestQueue" SET "leaseUntil"=clock_timestamp()-interval '1 second';`);
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_renew('${shop}','${token}',2);`),'0');
  assert.equal(sql(`SELECT kb_reingest_settle('${shop}','${token}',2,true,0,'completed');`),'f');
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_claim('${other}');`),'1','expired lease reclaimed');
  assert.equal(sql(`SELECT kb_reingest_settle('${shop}','${token}',2,true,0,'completed');`),'f','old nonce cannot settle replacement');
  assert.equal(sql(`SELECT kb_reingest_settle('${shop}','${other}',2,false,5000,'training_failed');`),'t');
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_claim('${token}');`),'0','backoff holds retry');
  sql(`UPDATE "KbReingestQueue" SET "dueAt"=clock_timestamp()-interval '1 second';`);
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_claim('${token}');`),'1');
  sql(`SELECT kb_reingest_cancel('${shop}');`);
  assert.equal(sql(`SELECT kb_reingest_owns('${shop}','${token}',2);`),'f');
  assert.equal(sql(`SELECT kb_reingest_enqueue('${shop}','after-uninstall');`),'inactive');
  assert.equal(sql('SELECT "requested"="completed" FROM "KbReingestQueue";'),'t');
  assert.throws(()=>sql("SELECT kb_reingest_enqueue('missing.myshopify.com','missing-event',true);"),/shop binding unavailable/);
  sql("INSERT INTO \"ShopTenant\"(\"shop\",\"provisionState\") VALUES('early.myshopify.com','pending');");
  assert.equal(sql("SELECT kb_reingest_enqueue('early.myshopify.com','early-event',true);"),'enqueued');
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_claim('${other}');`),'0','unprovisioned work remains pending');
  sql("UPDATE \"ShopTenant\" SET \"provisionState\"='published',\"bmaiTenantId\"='tenant-early' WHERE \"shop\"='early.myshopify.com';");
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_claim('${other}');`),'1');
  const duplicates=await Promise.all([parallel("SELECT kb_reingest_enqueue('early.myshopify.com','concurrent-event');"),parallel("SELECT kb_reingest_enqueue('early.myshopify.com','concurrent-event');")]);
  assert.deepEqual(duplicates.sort(),['duplicate','enqueued']);
  sql("UPDATE \"ShopTenant\" SET \"bmaiTenantId\"='replacement-tenant' WHERE \"shop\"='early.myshopify.com';");
  assert.equal(sql(`SELECT kb_reingest_owns('early.myshopify.com','${other}',1);`),'f','tenant rebind invalidates old ownership');
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_renew('early.myshopify.com','${other}',1);`),'0');
  assert.equal(sql(`SELECT kb_reingest_settle('early.myshopify.com','${other}',1,true,0,'completed');`),'f');
  sql("UPDATE \"KbReingestQueue\" SET \"leaseUntil\"=clock_timestamp()-interval '1 second',\"dueAt\"=clock_timestamp()-interval '1 second' WHERE \"shop\"='early.myshopify.com';");
  assert.equal(sql(`SELECT count(*) FROM kb_reingest_claim('${token}');`),'1');
  const settlements=await Promise.all([parallel(`SELECT kb_reingest_settle('early.myshopify.com','${token}',2,true,0,'completed');`),parallel(`SELECT kb_reingest_settle('early.myshopify.com','${token}',2,true,0,'completed');`)]);
  assert.deepEqual(settlements.sort(),['f','t'],'same nonce cannot settle twice under contention');
  await wait(100);const beforeRollback=wakes;
  sql("BEGIN; SELECT kb_reingest_enqueue('early.myshopify.com','rolled-back'); ROLLBACK;");
  await wait(100);assert.equal(wakes,beforeRollback,'rollback emits no wake');
  assert.equal(sql("SELECT count(*) FROM \"KbReingestReceipt\" WHERE \"webhookId\"='rolled-back';"),'0');
  sql("DELETE FROM \"ShopTenant\" WHERE \"shop\"='early.myshopify.com';");
  assert.equal(sql("SELECT count(*) FROM \"KbReingestReceipt\" WHERE \"shop\"='early.myshopify.com';"),'0','tenant purge cascades receipts');
  assert.equal(sql("SELECT count(*) FROM \"KbReingestQueue\" WHERE \"shop\"='early.myshopify.com';"),'0','tenant purge cascades queue');
 }finally{stopListening.abort();await listening;if(started)run('pg_ctl',['-D',data,'-w','stop','-m','fast']);rmSync(root,{recursive:true,force:true});}
});
