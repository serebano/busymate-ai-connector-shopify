import { beforeEach, expect, it, vi } from "vitest";
const read=vi.hoisted(()=>vi.fn());
vi.mock("../app/db.server",()=>({default:{$queryRaw:read}}));
import { loader } from "../app/routes/api.kb.queue-health";
beforeEach(()=>{ read.mockReset(); });
it("is green only with fresh worker evidence and no failed or overdue work",async()=>{
 read.mockResolvedValue([{pending:1,overdue:0,expired:0,failed:0,workerFresh:true,listenerConnected:true}]);
 const out=await loader();expect(out.status).toBe(200);expect(out.headers.get("cache-control")).toBe("no-store");
 expect(await out.json()).toEqual({ok:true,pending:1,overdue:0,expired:0,failed:0,workerFresh:true,listenerConnected:true});
});
it.each([{listenerConnected:false},{workerFresh:false},{overdue:1},{expired:1},{failed:1}])("fails closed for %s",async(bad)=>{
 read.mockResolvedValue([{pending:0,overdue:0,expired:0,failed:0,workerFresh:true,listenerConnected:true,...bad}]);expect((await loader()).status).toBe(503);
});
it("does not publish database errors or a success when persistence is unavailable",async()=>{
 read.mockRejectedValue(Error("synthetic private database detail"));const out=await loader();expect(out.status).toBe(503);
 expect(await out.json()).toEqual({ok:false,error:"queue_health_unavailable"});
});
