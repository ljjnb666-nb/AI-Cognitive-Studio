/**
 * Isolated Windows Microsoft Edge CDP acceptance for P127 review.
 * Synthetic PNG + JSON only; never accesses the user's real private books.
 * Run explicitly with --edge=<path to msedge.exe>.
 */
import {spawn,spawnSync} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {deflateSync} from "node:zlib";
import {startAnnotationServer} from "../annotation/server.mjs";
import {PRIVATE_FILENAMES,readPrivateP127Draft,readPrivateP127Bundle,
  readRegisteredGraphBundle} from "../annotation/private-graph-local.mjs";
import {TRUSTED_GRAPH_RESULTS} from "../annotation/graph-result-registry.mjs";

const sha=b=>createHash("sha256").update(b).digest("hex");
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
const stop=code=>{const e=new Error(code);e.code=code;throw e;};
function crc32(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return (n^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc]);}
function png(){
  const w=200,h=100,ihdr=Buffer.alloc(13),raw=Buffer.alloc(h*(1+w*4),255);
  ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  for(let i=0;i<h;i++)raw[i*(1+w*4)]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
async function fixture(root){
  const crop=png(),ch=sha(crop);
  const nodes=[
    {id:"n1",label:"合成客户端",bboxCropPixels:[10,20,50,30],proposalConfidence:.7,reviewStatus:"NOT_REVIEWED"},
    {id:"n2",label:"合成服务器",bboxCropPixels:[120,25,55,35],proposalConfidence:.7,reviewStatus:"NOT_REVIEWED"}
  ];
  const edges=[{id:"e1",fromNodeId:"n1",toNodeId:"n2",direction:"UNKNOWN",arrowTipCropPixels:[110,45],shaftCropPixels:[[75,45],[104,45]],proposalConfidence:.4,reviewStatus:"NOT_REVIEWED"}];
  const regions={schemaVersion:"acs-pdf-private-region-evidence-v1",sourceRun:"real-mineru-39440805765-1",fixtureId:"RB-PDF-13",allRegionsAreUnverified:true,noSemanticGraphClaims:true,pages:[{subsetPageIndex:1,sourcePhysicalPage1Based:127,regions:[{regionId:"page-002-region-01",proposalStatus:"UNVERIFIED_REGION_SUGGESTION",nodes:null,directedEdges:null,timingRelations:null,cropSha256:ch,bboxPixels:[100,200,200,100]}]}]};
  const manifest=Buffer.from(JSON.stringify(regions));
  const proposal={schemaVersion:"acs-vision-graph-proposal-v1",fixtureId:"RB-PDF-13",regionId:"page-002-region-01",sourceCropSha256:ch,coordinateSpace:"REGION_CROP_TOP_LEFT_PIXELS",graphStatus:"PROPOSED_UNVERIFIED",reviewStatus:"NOT_REVIEWED",humanVerified:false,nodes,edges};
  const mapped={regionId:"page-002-region-01",sourcePhysicalPage1Based:127,sourceCropSha256:ch,graphVerified:false,needsIndependentHumanReview:true,
    mappedNodes:nodes.map(n=>({id:n.id,bboxPagePixels:[100+n.bboxCropPixels[0],200+n.bboxCropPixels[1],n.bboxCropPixels[2],n.bboxCropPixels[3]],sourcePhysicalPage1Based:127,claim:"MACHINE_SUGGESTION_NOT_VERIFIED"})),
    mappedEdges:edges.map(e=>({id:e.id,arrowTipPagePixels:[100+e.arrowTipCropPixels[0],200+e.arrowTipCropPixels[1]],shaftPagePixels:e.shaftCropPixels.map(pt=>[100+pt[0],200+pt[1]]),sourcePhysicalPage1Based:127,claim:"GEOMETRIC_WITNESS_AND_RELATION_UNVERIFIED"}))};
  const result={schemaVersion:"acs-glm-cloud-vision-proposal-v1",sourceRun:"real-mineru-39440805765-1",fixtureId:"RB-PDF-13",provider:"ZHIPU_GLMCLOUD_STANDARD_API",model:"glm-5.3-flash",attemptClass:"EXPLICIT_P127_SECOND_ATTEMPT",transferScope:"EXPLICITLY_SELECTED_CROP_IMAGES_ONLY",sourceRegionManifestSha256:sha(manifest),reviewStatus:"NOT_REVIEWED",graphVerified:false,results:[{regionId:"page-002-region-01",sourcePhysicalPage1Based:127,cropSha256:ch,proposal,mappedPageEvidence:mapped,humanReviewStatus:"NOT_REVIEWED",graphVerified:false}]};
  for(const [name,data] of Object.entries({result:Buffer.from(JSON.stringify(result)),manifest,crop})){
    const p=join(root,...PRIVATE_FILENAMES[name].split("/"));await mkdir(dirname(p),{recursive:true});await writeFile(p,data);
  }
  // A second book and its graph model result exist only inside this isolated
  // temporary synthetic fixture. It never sends any real image to a model.
  const f2="RB-PDF-12",id2="page-001-region-01",page2=51;
  const m2=structuredClone(regions);
  m2.fixtureId=f2;m2.pages[0].subsetPageIndex=0;m2.pages[0].sourcePhysicalPage1Based=page2;
  m2.pages[0].regions[0].regionId=id2;
  const mb2=Buffer.from(JSON.stringify(m2));
  const r2=structuredClone(result);
  r2.fixtureId=f2;r2.attemptClass="EXPLICIT_P51_INITIAL_ATTEMPT";
  r2.sourceRegionManifestSha256=sha(mb2);
  r2.results[0].regionId=id2;r2.results[0].sourcePhysicalPage1Based=page2;
  r2.results[0].proposal.fixtureId=f2;r2.results[0].proposal.regionId=id2;
  r2.results[0].mappedPageEvidence.regionId=id2;
  r2.results[0].mappedPageEvidence.sourcePhysicalPage1Based=page2;
  for(const n of r2.results[0].mappedPageEvidence.mappedNodes)n.sourcePhysicalPage1Based=page2;
  for(const e of r2.results[0].mappedPageEvidence.mappedEdges)e.sourcePhysicalPage1Based=page2;
  const rb2=Buffer.from(JSON.stringify(r2));
  const reg={
    id:f2+":"+id2,fixtureId:f2,regionId:id2,physicalPage:page2,
    kind:"REGISTERED_REGION",sourceRun:"real-mineru-39440805765-1",
    provider:"ZHIPU_GLMCLOUD_STANDARD_API",model:"glm-5.3-flash",
    attemptClass:"EXPLICIT_P51_INITIAL_ATTEMPT",
    resultPath:"glm-cloud-v1-"+f2+"-"+id2+"-synthetic/cloud-vision-proposals.json",
    manifestPath:"region-proposals-v1-"+f2+"/region-proposals.json",
    cropPath:"region-proposals-v1-"+f2+"/crops/"+id2+".png",
    resultSha256:sha(rb2),manifestSha256:sha(mb2),cropSha256:ch
  };
  for(const [path,data] of [[reg.resultPath,rb2],[reg.manifestPath,mb2],[reg.cropPath,crop]]){
    const p=join(root,...path.split("/"));await mkdir(dirname(p),{recursive:true});await writeFile(p,data);
  }
  return reg;
}
class CDP {
  constructor(ws){
    this.ws=ws;this.id=0;this.pending=new Map();
    ws.addEventListener("message",event=>{
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      const p=this.pending.get(msg.id);if(!p)return;this.pending.delete(msg.id);
      msg.error?p.reject(Error("EDGE_CDP_COMMAND_FAILED")):p.resolve(msg.result);
    });
  }
  command(method,params={}){
    const id=++this.id;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      try{this.ws.send(JSON.stringify({id,method,params}));}
      catch{this.pending.delete(id);reject(Error("EDGE_CDP_SEND_FAILED"));}
    });
  }
  async value(expression){
    const data=await this.command("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(data.exceptionDetails)stop("EDGE_PAGE_EXCEPTION");
    return data.result?.value;
  }
}
async function connect(profile){
  let port;
  for(let i=0;i<100;i++){
    try{const raw=await readFile(join(profile,"DevToolsActivePort"),"utf8");port=Number(raw.split(/\r?\n/)[0]);if(Number.isInteger(port)&&port>0)break;}catch{}
    await delay(160);
  }
  if(!port)stop("EDGE_DEBUG_PORT_MISSING");
  let url;
  for(let i=0;i<70;i++){
    try{const r=await fetch("http://127.0.0.1:"+port+"/json");const targets=await r.json();url=targets.find(x=>x.type==="page")?.webSocketDebuggerUrl;if(url)break;}catch{}
    await delay(160);
  }
  if(!url)stop("EDGE_PAGE_TARGET_MISSING");
  const ws=new WebSocket(url);
  await new Promise((ok,failWait)=>{
    const t=setTimeout(()=>failWait(Error("EDGE_CDP_SOCKET_TIMEOUT")),8000);
    ws.addEventListener("open",()=>{clearTimeout(t);ok();},{once:true});
    ws.addEventListener("error",()=>{clearTimeout(t);failWait(Error("EDGE_CDP_SOCKET_ERROR"));},{once:true});
  });
  return new CDP(ws);
}
async function until(cdp,expression,error){
  for(let i=0;i<105;i++){
    try{if(await cdp.value(expression))return;}catch{}
    await delay(160);
  }
  stop(error);
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length!==1||!args[0].startsWith("--edge=")||!/msedge\.exe$/iu.test(args[0]))stop("EDGE_EXECUTABLE_REQUIRED");
  const edge=args[0].slice(7);
  const temp=await mkdtemp(join(tmpdir(),"acs-edge-p127-synthetic-"));
  const root=join(temp,"fake-private-reports","real-mineru-39440805765-1"),profile=join(temp,"edge-profile");
  let app,child,cdp;
  try{
    await mkdir(root,{recursive:true});
    const registration=await fixture(root),registrations=[...TRUSTED_GRAPH_RESULTS,registration];
    const token=randomBytes(32).toString("hex");
    app=await startAnnotationServer({privateGraphRoot:root,graphAccessToken:token,
      trustedGraphRegistrations:registrations});
    child=spawn(edge,["--headless=new","--disable-gpu","--disable-extensions","--disable-background-networking","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--remote-allow-origins=*","--user-data-dir="+profile,"--window-size=1280,900",app.url+"graph-review.html#review-token="+token],{stdio:"ignore",windowsHide:true});
    cdp=await connect(profile);
    await cdp.command("Runtime.enable");
    await until(cdp,'document.querySelector("#work")?.hidden === false',"EDGE_AUTO_IMPORT_TIMEOUT");
    const state=await cdp.value('({canvas:document.querySelector("#diagram").width>0,nodes:document.querySelector("#counts").textContent.includes("节点 2 个"),edges:document.querySelector("#counts").textContent.includes("关系 1 条"),choices:document.querySelectorAll("#entries select").length===3,unverified:document.querySelector("#export-panel").textContent.includes("graphVerified=false")})');
    if(!state||!Object.values(state).every(Boolean))stop("EDGE_AUTO_IMPORT_DISPLAY_REJECTED");
    await until(cdp,'document.querySelectorAll("#queue-items .queue-item").length===2',"EDGE_SYNTHETIC_QUEUE_TIMEOUT");
    const queued=await cdp.value('({total:document.querySelector("#queue-summary")?.textContent.includes("已发现 2 个区域"),ready:document.querySelector("#queue-summary")?.textContent.includes("可审核 2"),entry:document.querySelectorAll("#queue-items button.primary").length===2})');
    if(!queued||!Object.values(queued).every(Boolean))stop("EDGE_SYNTHETIC_QUEUE_REJECTED");

    await cdp.value('(()=>{const button=document.querySelector("#queue-items .crop-preview-button");if(!button)return false;button.click();return true;})()');
    await until(cdp,'document.querySelector("#crop-preview")?.hidden === false && document.querySelector("#crop-preview-canvas")?.width > 0 && document.querySelector("#crop-preview-status")?.textContent.includes("校验通过")',"EDGE_SYNTHETIC_PREVIEW_TIMEOUT");
    console.log("ACS_P127_EDGE_SYNTHETIC_SHA_PREVIEW_PASS");
    await until(cdp,'document.querySelector("#batch-plan-state")?.textContent.includes("已发现 2 个区域") && document.querySelector("#batch-plan-state")?.textContent.includes("需推理 0")',"EDGE_SYNTHETIC_BATCH_PLAN_TIMEOUT");
    const noPaid=await cdp.value('document.querySelector("#batch-plan-details")?.textContent.includes("实际付费调用 0 次")');
    if(!noPaid)stop("EDGE_SYNTHETIC_BATCH_DISPATCH_NOT_DISABLED");
    console.log("ACS_03E04_EDGE_SYNTHETIC_ZERO_COST_PLAN_PASS=true");
    console.log("ACS_P127_EDGE_SYNTHETIC_QUEUE_PASS");
    console.log("ACS_P127_EDGE_SYNTHETIC_IMPORT_AND_OVERLAY_PASS");
    await cdp.value('(()=>{const s=document.querySelector("#entries select");s.value="UNCERTAIN";s.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await until(cdp,'document.querySelector("#autosave-state")?.textContent.includes("已保存到本机 D 盘")',"EDGE_AUTOSAVE_TIMEOUT");
    const checked=await readPrivateP127Draft(root,(await readPrivateP127Bundle(root)).view);
    if(checked.draft?.decisions[0]?.decision!=="UNCERTAIN"||checked.draft.graphVerified!==false)stop("EDGE_AUTOSAVE_DRAFT_INVALID");
    console.log("ACS_P127_EDGE_SYNTHETIC_PRIVATE_SAVE_PASS");
    await cdp.command("Page.reload",{ignoreCache:true});
    await until(cdp,'document.querySelector("#autosave-state")?.textContent.includes("已恢复") && document.querySelector("#entries select")?.value==="UNCERTAIN"',"EDGE_REFRESH_RESTORE_TIMEOUT");
    console.log("ACS_P127_EDGE_SYNTHETIC_RELOAD_RESTORE_PASS");
    // Exercise second-book registered graph review via the actual unified UI,
    // separate CAS-backed draft and refresh recovery.
    const picked=await cdp.value('(()=>{const cards=[...document.querySelectorAll("#queue-items .queue-item")];const b=cards.find(c=>c.textContent.includes("RB-PDF-12"))?.querySelector("button.primary");if(!b)return false;b.click();return true;})()');
    if(!picked)stop("EDGE_GENERIC_ENTRY_NOT_AVAILABLE");
    await until(cdp,'document.querySelector("#review-scope")?.textContent.includes("RB-PDF-12") && document.querySelector("#work")?.hidden===false',"EDGE_GENERIC_REGION_LOAD_TIMEOUT");
    const generic=await cdp.value('({scope:document.querySelector("#review-scope")?.textContent.includes("物理 P51"),entries:document.querySelectorAll("#entries select").length===3,unverified:document.querySelector("#export-panel")?.textContent.includes("graphVerified=false")})');
    if(!generic||!Object.values(generic).every(Boolean))stop("EDGE_GENERIC_REGION_DISPLAY_REJECTED");
    console.log("ACS_03E03_EDGE_GENERIC_SECOND_BOOK_IMPORT_PASS=true");
    await cdp.value('(()=>{const s=document.querySelector("#entries select");s.value="VISIBLE_MATCH";s.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await until(cdp,'document.querySelector("#autosave-state")?.textContent.includes("已保存到本机 D 盘")',"EDGE_GENERIC_AUTOSAVE_TIMEOUT");
    const savedGeneric=await readRegisteredGraphBundle(root,registration.id,registrations);
    if(savedGeneric.saved.draft?.decisions[0]?.decision!=="VISIBLE_MATCH"||
       savedGeneric.saved.draft.graphVerified!==false)
      stop("EDGE_GENERIC_DRAFT_NOT_PERSISTED");
    const pinnedLegacy=await readPrivateP127Draft(root,(await readPrivateP127Bundle(root)).view);
    if(pinnedLegacy.draft?.decisions[0]?.decision!=="UNCERTAIN")
      stop("EDGE_GENERIC_CHANGED_LEGACY_DRAFT");
    await cdp.command("Page.reload",{ignoreCache:true});
    await until(cdp,'document.querySelectorAll("#queue-items .queue-item").length===2 && document.querySelector("#work")?.hidden===false',"EDGE_GENERIC_RELOAD_QUEUE_TIMEOUT");
    await cdp.value('(()=>{const c=[...document.querySelectorAll("#queue-items .queue-item")].find(x=>x.textContent.includes("RB-PDF-12"));c?.querySelector("button.primary")?.click();return true;})()');
    await until(cdp,'document.querySelector("#review-scope")?.textContent.includes("RB-PDF-12") && document.querySelector("#entries select")?.value==="VISIBLE_MATCH" && document.querySelector("#autosave-state")?.textContent.includes("已恢复")',"EDGE_GENERIC_REFRESH_RESTORE_TIMEOUT");
    console.log("ACS_03E03_EDGE_GENERIC_SECOND_BOOK_SAVE_RESTORE_PASS=true");
    console.log("ACS_03E03_EDGE_LEGACY_DRAFT_NOT_OVERWRITTEN=true");
    console.log("ACS_P127_EDGE_GRAPH_VERIFIED=false");
    console.log("ACS_P127_EDGE_REAL_PRIVATE_DATA_TOUCHED=false");
  }finally{
    try{cdp?.ws.close();}catch{}
    if(child?.pid)spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true,timeout:9000});
    try{await app?.close();}catch{}
    await rm(temp,{recursive:true,force:true,maxRetries:6,retryDelay:250}).catch(()=>{});
  }
}
main().catch(e=>{
  let code=e?.code??e?.message;
  if(typeof code!=="string"||!/^[A-Z0-9_]{3,80}$/u.test(code))code="EDGE_ACCEPTANCE_FAILED";
  console.error("ACS_P127_EDGE_SYNTHETIC_BLOCKED="+code);
  process.exitCode=2;
});
