import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("../app/db.server",()=>({default:{}}));
import { runReingestChild } from "../app/lib/reingestProcess.server";
const lease={shop:"fixture.myshopify.com",token:"synthetic-lease",generation:1,attempt:1,expiresAt:new Date()};
it("aborting an owned hanging child waits for actual process termination",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"bmai-worker-child-"));
 try{
  const child=join(dir,"hang.mjs");await writeFile(child,'process.on("message",()=>{setInterval(()=>{},1000);});');
  const controller=new AbortController();const out=runReingestChild(lease,controller.signal,child);
  controller.abort();await expect(out).rejects.toThrow("attempt_failed");
 }finally{await rm(dir,{recursive:true,force:true});}
});
it("a new child can complete a retry after the previous child exited",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"bmai-worker-restart-"));
 try{
  const child=join(dir,"success.mjs");await writeFile(child,'process.on("message",()=>process.send({ok:true,counts:{products:0,policies:0,pages:0},fetched:{products:0,policies:0,pages:0},totalChars:0,truncated:false},()=>process.exit(0)));');
  expect((await runReingestChild(lease,new AbortController().signal,child)).ok).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("kills only its owned child if that child ignores graceful termination",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"bmai-worker-stubborn-"));
 const controller=new AbortController();let running: ReturnType<typeof runReingestChild> | undefined;
 try{
  const child=join(dir,"stubborn.mjs"),ready=join(dir,"ready");
  await writeFile(child,`import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); process.on('message',()=>{writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);});`);
  const out=runReingestChild(lease,controller.signal,child);running=out;
  let pid=0;
  for(let i=0;i<200&&!pid;i++){try{pid=Number(await readFile(ready,"utf8"));}catch{await new Promise(r=>setTimeout(r,10));}}
  expect(pid).toBeGreaterThan(0);
  const refused=expect(out).rejects.toThrow("attempt_failed");controller.abort();await refused;
  expect(()=>process.kill(pid,0)).toThrow();
 }finally{controller.abort();await running?.catch(()=>undefined);await rm(dir,{recursive:true,force:true});}
},10000);
