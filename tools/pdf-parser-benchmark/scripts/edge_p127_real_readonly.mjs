/**
 * Real P127 Edge visual load acceptance, strictly READ-ONLY.
 * No changes to user's draft, no GLM calls, no screenshots or private labels in CI.
 */
import {spawn,spawnSync} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startAnnotationServer} from "../annotation/server.mjs";
import {PRIVATE_FILENAMES,readPrivateP127Bundle} from "../annotation/private-graph-local.mjs";
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
async function fileHash(path){
  try{return createHash("sha256").update(await readFile(path)).digest("hex");}
  catch(e){if(e.code==="ENOENT")return null;fail("PRIVATE_DRAFT_READ_NOT_SAFE");}
}
class CDP {
  constructor(ws){
    this.ws=ws;this.i=0;this.pending=new Map();
    ws.addEventListener("message",ev=>{
      let m;try{m=JSON.parse(ev.data);}catch{return;}
      const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);
      m.error?p.reject(Error("EDGE_CDP_ERROR")):p.resolve(m.result);
    });
  }
  command(method,params={}){
    const id=++this.i;return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      try{this.ws.send(JSON.stringify({id,method,params}));}
      catch{this.pending.delete(id);reject(Error("EDGE_CDP_SEND_ERROR"));}
    });
  }
  async evaluate(expression){
    const r=await this.command("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)fail("EDGE_PAGE_EXCEPTION");
    return r.result?.value;
  }
}
async function connect(profile){
  let port;
  for(let n=0;n<100;n++){
    try{const contents=await readFile(join(profile,"DevToolsActivePort"),"utf8");port=Number(contents.split(/\r?\n/)[0]);if(port>0&&port<65536)break;}catch{}
    await delay(160);
  }
  if(!port)fail("EDGE_DEBUG_PORT_MISSING");
  let wsUrl;
  for(let n=0;n<70;n++){
    try{const resp=await fetch("http://127.0.0.1:"+port+"/json");const targets=await resp.json();wsUrl=targets.find(t=>t.type==="page")?.webSocketDebuggerUrl;if(wsUrl)break;}catch{}
    await delay(160);
  }
  if(!wsUrl)fail("EDGE_TARGET_MISSING");
  const ws=new WebSocket(wsUrl);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error("EDGE_SOCKET_TIMEOUT")),8000);
    ws.addEventListener("open",()=>{clearTimeout(timer);resolve();},{once:true});
    ws.addEventListener("error",()=>{clearTimeout(timer);reject(Error("EDGE_SOCKET_ERROR"));},{once:true});
  });
  return new CDP(ws);
}
async function main(){
  const arg=process.argv.slice(2);
  if(arg.length!==2||!arg[0].startsWith("--edge=")||!/msedge\.exe$/iu.test(arg[0])||!arg[1].startsWith("--root="))fail("EDGE_READONLY_ARGUMENT_INVALID");
  const edge=arg[0].slice(7),root=arg[1].slice(7);
  const bundle=await readPrivateP127Bundle(root);
  if(bundle.view.nodes.length!==9||bundle.view.edges.length!==10||bundle.view.graphVerified!==false||bundle.view.reviewStatus!=="NOT_REVIEWED")fail("EDGE_PRIVATE_SOURCE_NOT_EXPECTED");
  const draftFile=join(root,...PRIVATE_FILENAMES.draft.split("/"));
  const before=await fileHash(draftFile);
  const temp=await mkdtemp(join(tmpdir(),"acs-p127-real-edge-readonly-"));
  const profile=join(temp,"isolated-browser");
  let app,child,cdp;
  try{
    const token=randomBytes(32).toString("hex");
    // Even a valid local token cannot write a review draft in this acceptance.
    app=await startAnnotationServer({privateGraphRoot:root,graphAccessToken:token,privateGraphReadOnly:true});
    child=spawn(edge,["--headless=new","--disable-gpu","--disable-extensions","--disable-background-networking","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--remote-allow-origins=*","--user-data-dir="+profile,"--window-size=1280,900",app.url+"graph-review.html#review-token="+token],{stdio:"ignore",windowsHide:true});
    cdp=await connect(profile);await cdp.command("Runtime.enable");
    let reached=false;
    for(let n=0;n<110;n++){
      try{reached=await cdp.evaluate('document.querySelector("#work")?.hidden === false');if(reached)break;}catch{}
      await delay(160);
    }
    if(!reached)fail("EDGE_REAL_P127_AUTO_IMPORT_TIMEOUT");
    const v=await cdp.evaluate('({canvas:document.querySelector("#diagram").width>0,nodes:document.querySelector("#counts").textContent.includes("节点 9 个"),edges:document.querySelector("#counts").textContent.includes("关系 10 条"),choices:document.querySelectorAll("#entries select").length===19,privateLink:document.querySelector("#export-panel").textContent.includes("graphVerified=false")})');
    if(!v||!Object.values(v).every(Boolean))fail("EDGE_REAL_P127_RENDER_OR_COUNT_REJECTED");
    for(let n=0;n<110;n++){
      const done=await cdp.evaluate('document.querySelectorAll("#queue-items .queue-item").length === 15');
      if(done)break;
      if(n===109)fail("EDGE_REAL_P127_QUEUE_TIMEOUT");
      await delay(160);
    }
    const queueReady=await cdp.evaluate('({total:document.querySelector("#queue-summary")?.textContent.includes("已发现 15 个区域"),ready:document.querySelector("#queue-summary")?.textContent.includes("可审核 1"),cropOnly:document.querySelector("#queue-summary")?.textContent.includes("只有裁剪 14"),blocked:document.querySelector("#queue-summary")?.textContent.includes("证据异常 0"),reviewEntry:document.querySelectorAll("#queue-items button.primary").length===1})');
    if(!queueReady||!Object.values(queueReady).every(Boolean))fail("EDGE_REAL_P127_QUEUE_REJECTED");
    console.log("ACS_P127_EDGE_REAL_QUEUE_TOTAL=15");
    console.log("ACS_P127_EDGE_REAL_QUEUE_REVIEWABLE=1");
    console.log("ACS_P127_EDGE_REAL_QUEUE_CROP_ONLY=14");
    console.log("ACS_P127_EDGE_REAL_PRIVATE_READONLY_LOADED=true");
    console.log("ACS_P127_EDGE_REAL_PRIVATE_NODES=9");
    console.log("ACS_P127_EDGE_REAL_PRIVATE_EDGES=10");
    console.log("ACS_P127_EDGE_REAL_PRIVATE_GRAPH_VERIFIED=false");
  }finally{
    try{cdp?.ws.close();}catch{}
    if(child?.pid)spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true,timeout:9000});
    try{await app?.close();}catch{}
    await rm(temp,{recursive:true,force:true,maxRetries:6,retryDelay:250}).catch(()=>{});
    const after=await fileHash(draftFile);
    if(before!==after)fail("EDGE_READONLY_DRAFT_MUTATED");
    console.log("ACS_P127_EDGE_REAL_DRAFT_UNCHANGED=true");
  }
}
main().catch(e=>{
  let code=e?.code??e?.message;if(typeof code!=="string"||!/^[A-Z0-9_]{3,80}$/u.test(code))code="EDGE_REAL_READONLY_UNKNOWN";
  console.error("ACS_P127_EDGE_REAL_READONLY_BLOCKED="+code);process.exitCode=2;
});
