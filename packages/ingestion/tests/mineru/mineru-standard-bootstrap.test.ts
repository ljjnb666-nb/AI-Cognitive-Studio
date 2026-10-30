import { createServer, type RequestListener } from "node:http";
import { afterEach, expect, it } from "vitest";
import { setParseServerModeManaged, waitForStandardParseServerReady } from "../../src/mineru/mineru-standard-server-setup.js";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
async function endpoint(handler: RequestListener) {
  const s = createServer(handler); servers.push(s);
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as {port:number}).port}`;
}
it("enables managed mode then waits for positive standard readiness without restarting doclib", async () => {
  let enabled = false; let probes = 0;
  const base = await endpoint((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "PUT") { enabled = true; res.end("{}"); return; }
    probes++;
    res.end(JSON.stringify({parse_server:{local:{healthy: enabled && probes > 1, managed_running:true, managed_tier:"standard", supported_tiers:["standard"]}}}));
  });
  expect(await setParseServerModeManaged(base, 500)).toBeNull();
  expect(await waitForStandardParseServerReady(base, 1000, {pollIntervalMs:5})).toBeNull();
  expect(probes).toBeGreaterThan(1);
});
it("does not follow a loopback redirect to another endpoint", async () => {
  let contacted = false;
  const target = await endpoint((_req,res) => {contacted=true; res.end("{}");});
  const base = await endpoint((_req,res) => {res.writeHead(307,{location:target});res.end();});
  expect((await setParseServerModeManaged(base,500))?.kind).toBe("CONFIG_SET_FAILED");
  expect(contacted).toBe(false);
});
it("bounds unavailable readiness and responds to an already cancelled claim", async () => {
  const base = await endpoint((_req,res) => res.end("{}"));
  expect((await waitForStandardParseServerReady(base,20,{pollIntervalMs:5}))?.kind).toBe("READINESS_TIMEOUT");
  const controller=new AbortController(); controller.abort();
  expect((await waitForStandardParseServerReady(base,1000,{signal:controller.signal}))?.detail).toBe("aborted");
  expect((await setParseServerModeManaged(base,500,controller.signal))?.kind).toBe("CONFIG_SET_FAILED");
});
it("refuses a different doclib identity before changing managed mode",async()=>{
 let writes=0;
 const base=await endpoint((req,res)=>{if(req.method==="PUT")writes++;res.setHeader("content-type","application/json");res.end(JSON.stringify({running:true,pid:123,server_id:"wrong"}));});
 expect(await setParseServerModeManaged(base,500,undefined,{pid:123,serverId:"owned"})).toMatchObject({detail:"CLAIM_SERVER_IDENTITY_MISMATCH"});
 expect(writes).toBe(0);
 expect(await waitForStandardParseServerReady(base,500,{expectedIdentity:{pid:123,serverId:"owned"}})).toMatchObject({detail:"CLAIM_SERVER_IDENTITY_MISMATCH"});
});
it("binds ready status to the generated managed-engine port and captures its pid",async()=>{
 let port=54321;let captured:unknown;
 const base=await endpoint((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({running:true,pid:123,server_id:"owned",parse_server:{local:{healthy:true,managed_running:true,managed_tier:"standard",managed_pid:456,port,url:`http://127.0.0.1:${port}`}}}));});
 expect((await waitForStandardParseServerReady(base,20,{pollIntervalMs:2,expectedIdentity:{pid:123,serverId:"owned"},expectedManagedPort:54322}))?.kind).toBe("READINESS_TIMEOUT");
 port=54322;
 expect(await waitForStandardParseServerReady(base,500,{expectedIdentity:{pid:123,serverId:"owned"},expectedManagedPort:54322,onReady:local=>{captured=local.managed_pid;}})).toBeNull();
 expect(captured).toBe(456);
});
it("bounds an oversized status response",async()=>{
 const base=await endpoint((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({padding:"x".repeat(300000)}));});
 expect((await waitForStandardParseServerReady(base,30,{pollIntervalMs:2}))?.kind).toBe("READINESS_TIMEOUT");
});
