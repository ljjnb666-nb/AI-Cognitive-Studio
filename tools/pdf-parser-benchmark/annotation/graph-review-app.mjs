import {
  MAX_RESULT_BYTES, MAX_MANIFEST_BYTES, MAX_CROP_BYTES, MAX_REVIEW_BYTES,
  validateGraphReviewSource, createGraphReviewDraft, parseGraphReviewDraft,
  updateGraphDecision, graphReviewProgress, GraphReviewError,
} from "./graph-review.mjs";
import { verifyAutoGraphBundle } from "./graph-review-auto.mjs";
import { verifyGraphCropPreview } from "./graph-crop-preview.mjs";
import {validateRegionGraphCandidate,createRegionReviewDraft,parseRegionReviewDraft,
  updateRegionReviewDraft,regionReviewProgress,regionReviewDraftFilename} from "./region-graph-review.mjs";

const $=id=>document.getElementById(id);
const el=(tag,klass,text)=>{
  const x=document.createElement(tag);if(klass)x.className=klass;
  if(text!==undefined)x.textContent=String(text);return x;
};
let view=null,draft=null,bitmap=null,selected=null,loadEpoch=0;
const token=new URLSearchParams(location.hash.slice(1)).get("review-token");
const hasLocalToken=typeof token==="string"&&/^[0-9a-f]{64}$/u.test(token);
let autoActive=false,saveRevision=null,saveTimer=null,saveQueue=Promise.resolve(),saveEpoch=0;
let activeReviewKind="LEGACY_P127",activeItemId=null;
let localEditSerial=0,persistedEditSerial=0,restoreEpoch=0;
function hasUnpersistedEdits(){return localEditSerial!==persistedEditSerial||saveTimer!==null;}
function allowReviewSwitch(){
  if(!hasUnpersistedEdits())return true;
  message("当前区域仍有未完成的草稿保存。请等待“已保存到本机 D 盘”，若保存失败请先导出 JSON；为防止丢失修改，已阻止切换。");
  return false;
}
function resetEditTracking(){localEditSerial=0;persistedEditSerial=0;}
const useGeneric=()=>["REGISTERED_REGION","STAGED_REGION"].includes(activeReviewKind);
const currentParse=(raw,v)=>useGeneric()?parseRegionReviewDraft(raw,v):parseGraphReviewDraft(raw,v);
const currentUpdate=(raw,v,kind,id,decision,note)=>useGeneric()?
  updateRegionReviewDraft(raw,v,kind,id,decision,note):
  updateGraphDecision(raw,v,kind,id,decision,note);
const currentProgress=(raw,v)=>useGeneric()?regionReviewProgress(raw,v):graphReviewProgress(raw,v);
const draftEndpoint=()=>activeReviewKind==="STAGED_REGION"?
  "/api/private-graph/intake/staged/draft?item="+encodeURIComponent(activeItemId):
  useGeneric()?"/api/private-graph/registered/draft?item="+encodeURIComponent(activeItemId):
  "/api/private-graph/p127/draft";
function saveStatus(value){$("autosave-state").textContent="自动保存："+value;}
function autoHeaders(extra={}){return {...extra,"x-acs-review-token":hasLocalToken?token:""};}
async function autoRequest(url,config={}){
  const response=await fetch(url,{cache:"no-store",credentials:"omit",
    ...config,headers:autoHeaders(config.headers)});
  if(!response.ok){
    let code="PRIVATE_AUTO_IMPORT_REJECTED";
    try{const value=await response.json();if(/^PRIVATE_[A-Z0-9_]{3,80}$/u.test(value.code))code=value.code;}catch{}
    throw new GraphReviewError(code);
  }
  return response.json();
}
function cancelAutoSave(){
  ++saveEpoch;
  if(saveTimer!==null){clearTimeout(saveTimer);saveTimer=null;}
  autoActive=false;saveRevision=null;
  saveStatus("未启用");
}
function scheduleAutoSave(){
  if(!view||!draft)return;
  ++localEditSerial;
  if(!autoActive){saveStatus("本地草稿未自动保存 · 请导出 JSON");return;}
  if(saveTimer!==null)clearTimeout(saveTimer);
  const epoch=saveEpoch;
  saveStatus("有待保存的修改");
  saveTimer=setTimeout(()=>{
    saveTimer=null;
    const stored=structuredClone(draft);
    const storedSerial=localEditSerial;
    const lineage=view.resultSha256;
    const sourceItem=activeItemId,reviewMode=activeReviewKind;
    const next=saveQueue.then(async()=>{
      if(!autoActive||saveEpoch!==epoch||!view||view.resultSha256!==lineage||
         activeItemId!==sourceItem||activeReviewKind!==reviewMode)return;
      saveStatus("保存中…");
      try{
        const result=await autoRequest(draftEndpoint(),{
          method:"PUT",
          headers:{"Content-Type":"application/json","x-acs-draft-revision":saveRevision??"none"},
          body:JSON.stringify(stored),
        });
        if(saveEpoch!==epoch||!autoActive||!view||view.resultSha256!==lineage||
           activeItemId!==sourceItem||activeReviewKind!==reviewMode)return;
        if(!/^[0-9a-f]{64}$/u.test(result.revision)||result.status!=="REVIEW_DRAFT_UNATTESTED")
          throw new GraphReviewError("PRIVATE_DRAFT_RECEIPT_INVALID");
        saveRevision=result.revision;
        persistedEditSerial=storedSerial;
        saveStatus(hasUnpersistedEdits()?"新修改等待保存":"已保存到本机 D 盘（未认证草稿）");
        if(!hasUnpersistedEdits()){void loadIntakeOverview();void loadQueue();}
      }catch(error){
        if(saveEpoch!==epoch)return;
        autoActive=false;
        saveStatus("保存失败／版本冲突：已停止自动保存");
        message("自动保存失败（"+(error instanceof GraphReviewError?error.code:"PRIVATE_DRAFT_SAVE_FAILED")+"）。本页人工草稿仍保留，可立即手动导出 JSON。");
      }
    });
    saveQueue=next.catch(()=>{});
  },450);
}
const options=[
  ["UNREVIEWED","未审阅"],["VISIBLE_MATCH","与可见图像一致（草稿）"],
  ["VISIBLE_MISMATCH","与可见图像不一致"],["UNCERTAIN","无法判断／局部图像不清晰"],
];
function message(text,good=false){$("notice").textContent=text;$("notice").classList.toggle("ok",good);}
function reset(clearFiles=false){
  if(!allowReviewSwitch())return;
  ++loadEpoch;cancelAutoSave();resetEditTracking();activeReviewKind="LEGACY_P127";activeItemId=null;
  if(bitmap){bitmap.close();bitmap=null;}
  if(clearFiles)for(const id of ["result-file","manifest-file","crop-file","restore"])$(id).value="";
  view=null;draft=null;selected=null;$("work").hidden=true;$("export-panel").hidden=true;
  $("entries").replaceChildren();const c=$("diagram");c.width=0;c.height=0;
  message("未加载私人证据。所有本地审阅草稿已从页面内存清空。");
}
function fileCheck(id,name,max){
  const f=$(id).files?.[0];
  if(!f||f.name!==name||!Number.isSafeInteger(f.size)||f.size<8||f.size>max)
    throw new GraphReviewError("GRAPH_FILE_MISSING_OR_SIZE_INVALID");
  return f;
}
async function digest(bytes){
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,"0")).join("");
}
function parseJSON(bytes){
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{throw new GraphReviewError("GRAPH_SOURCE_JSON_INVALID");}
}
function draw(){
  if(!view||!bitmap)return;
  const c=$("diagram");
  const limit=4_000_000;
  const s=Math.min(1,Math.sqrt(limit/(view.width*view.height)));
  c.width=Math.max(1,Math.floor(view.width*s));c.height=Math.max(1,Math.floor(view.height*s));
  const ctx=c.getContext("2d");if(!ctx)return;
  ctx.setTransform(c.width/view.width,0,0,c.height/view.height,0,0);
  ctx.drawImage(bitmap,0,0,view.width,view.height);
  const scale=Math.max(1,Math.min(view.width,view.height)/400);
  ctx.font=(14*scale)+"px Consolas";
  for(const n of view.nodes){
    ctx.strokeStyle=selected==="node:"+n.id?"#bb2850":"#13866e";
    ctx.lineWidth=(selected==="node:"+n.id?4:2)*scale;
    ctx.strokeRect(...n.box);
    ctx.fillStyle="#085548";ctx.fillText(n.id,n.box[0],Math.max(14*scale,n.box[1]-3*scale));
  }
  for(const e of view.edges){
    ctx.strokeStyle=selected==="edge:"+e.id?"#c4284e":"#e08021";
    ctx.lineWidth=(selected==="edge:"+e.id?5:3)*scale;
    ctx.beginPath();ctx.moveTo(...e.shaft[0]);ctx.lineTo(...e.shaft[1]);ctx.stroke();
    ctx.beginPath();ctx.arc(e.tip[0],e.tip[1],5*scale,0,Math.PI*2);ctx.fillStyle=ctx.strokeStyle;ctx.fill();
    ctx.fillText(e.id,e.tip[0]+6*scale,e.tip[1]-5*scale);
  }
}
function render(){
  if(!view||!draft)return;
  const progress=currentProgress(draft,view);
  $("counts").textContent="候选节点 "+view.nodes.length+" 个，候选关系 "+view.edges.length+
    " 条；人工草稿已处理 "+progress.reviewed+"/"+progress.total+
    " 项（其中无法判断 "+progress.uncertain+" 项）。无认证结论。";
  const container=$("entries");
  const fragment=document.createDocumentFragment();
  const records=[
    ...view.nodes.map(n=>({kind:"node",id:n.id,desc:"候选文字："+n.label+"；节点框 "+n.box.join(", ")})),
    ...view.edges.map(e=>({kind:"edge",id:e.id,desc:"机器提议："+e.from+" → "+e.to+"；方向："+e.direction+"；尖端 "+e.tip.join(", ")})),
  ];
  for(const r of records){
    const v=draft.decisions.find(d=>d.kind===r.kind&&d.id===r.id);
    const item=el("article","reviewitem"+(selected===r.kind+":"+r.id?" active":""));
    const title=el("div","head");
    const focus=el("button","idtag",(r.kind==="node"?"节点 ":"关系 ")+r.id);
    focus.type="button";focus.addEventListener("click",()=>{selected=r.kind+":"+r.id;draw();render();});
    title.append(focus,el("small","",r.kind==="node"?"检查标签及框位置":"检查可见线段、箭头尖端和方向"));
    item.append(title,el("p","text",r.desc));
    const lbl=el("label","","肉眼审阅状态");const select=el("select");
    for(const [value,text] of options){
      const o=el("option","",text);o.value=value;o.selected=v.decision===value;select.append(o);
    }
    select.addEventListener("change",()=>{
      try{
        draft=currentUpdate(draft,view,r.kind,r.id,select.value,select.value==="UNREVIEWED"?"":v.note);
        render();scheduleAutoSave();
        message("已更新本机草稿；"+(autoActive?"等待本机自动保存。":"请手动导出草稿。"),true);
      }catch{message("审阅状态不合法，未修改草稿。");render();}
    });
    lbl.append(select);item.append(lbl);
    const nlabel=el("label","","审阅备注（最多 280 字）");
    const field=el("input");field.type="text";field.maxLength=280;field.value=v.note;field.placeholder="例如：箭头尖端模糊，不可确定方向";
    field.disabled=v.decision==="UNREVIEWED";
    field.addEventListener("change",()=>{
      try{draft=currentUpdate(draft,view,r.kind,r.id,v.decision,field.value);render();scheduleAutoSave();message("已更新本机备注；"+(autoActive?"等待本机自动保存。":"请导出草稿。"),true);}
      catch{message("备注格式不合法，未保存。");render();}
    });
    nlabel.append(field);item.append(nlabel);fragment.append(item);
  }
  container.replaceChildren(fragment);
}
async function load(){
  if(!allowReviewSwitch())return;
  cancelAutoSave();resetEditTracking();
  const epoch=++loadEpoch;
  if(bitmap){bitmap.close();bitmap=null;}
  view=null;draft=null;$("work").hidden=true;$("export-panel").hidden=true;
  try{
    if(!crypto?.subtle)throw new GraphReviewError("GRAPH_BROWSER_SHA_UNAVAILABLE");
    const rf=fileCheck("result-file","cloud-vision-proposals.json",MAX_RESULT_BYTES);
    const mf=fileCheck("manifest-file","region-proposals.json",MAX_MANIFEST_BYTES);
    const cf=fileCheck("crop-file","page-002-region-01.png",MAX_CROP_BYTES);
    message("正在本机读取文件、计算 SHA 与校验坐标；不会上传…");
    const [rb,mb,cb]=await Promise.all([rf.arrayBuffer(),mf.arrayBuffer(),cf.arrayBuffer()]);
    const magic=new Uint8Array(cb,0,Math.min(8,cb.byteLength));
    if(magic.length!==8||magic.some((b,i)=>b!==[137,80,78,71,13,10,26,10][i]))
      throw new GraphReviewError("GRAPH_CROP_NOT_PNG");
    const [resultSha256,manifestSha256,cropSha256]=await Promise.all([digest(rb),digest(mb),digest(cb)]);
    const image=await createImageBitmap(cf);
    try{
      if(epoch!==loadEpoch)return;
      const validated=validateGraphReviewSource(parseJSON(rb),parseJSON(mb),
        {resultSha256,manifestSha256,cropSha256,cropWidth:image.width,cropHeight:image.height});
      if(epoch!==loadEpoch)return;
      activeReviewKind="LEGACY_P127";activeItemId=null;
      view=validated;draft=createGraphReviewDraft(view);bitmap=image;selected=null;
      $("review-scope").textContent="当前审核：RB-PDF-13 · 物理 P127 · 既有专用草稿";
      $("work").hidden=false;$("export-panel").hidden=false;
      draw();render();message("SHA / 物理 P127 / 节点关系坐标校验通过。所有候选仍未审阅。",true);
    }finally{if(bitmap!==image)image.close();}
  }catch(error){
    const code=error instanceof GraphReviewError?error.code:"GRAPH_LOCAL_FILE_OR_IMAGE_BLOCKED";
    message("已拒绝导入（"+code+"）；未创建人工结论。");
  }
}
async function restoreDraft(){
  if(!view||!allowReviewSwitch())return;
  const expectedEpoch=loadEpoch;
  const expectedSha=view.resultSha256;
  const expectedSerial=localEditSerial,expectedRevision=saveRevision;
  const expectedKind=activeReviewKind,expectedItem=activeItemId;
  const requestEpoch=++restoreEpoch;
  const f=$("restore").files?.[0];
  if(!f||f.size<8||f.size>MAX_REVIEW_BYTES){message("已有草稿文件无效或过大。");return;}
  try{
    const raw=parseJSON(await f.arrayBuffer());
    // File.arrayBuffer() is asynchronous: a new edit, later restore or
    // source/revision change must invalidate this pending file read. Otherwise
    // a slow disk picker could overwrite a newer human decision in memory.
    if(loadEpoch!==expectedEpoch||!view||view.resultSha256!==expectedSha||
       localEditSerial!==expectedSerial||saveRevision!==expectedRevision||
       activeReviewKind!==expectedKind||activeItemId!==expectedItem||
       requestEpoch!==restoreEpoch||hasUnpersistedEdits())
      throw new GraphReviewError("GRAPH_RESTORE_STALE_SELECTION_OR_EDIT");
    draft=currentParse(raw,view);
    selected=null;render();draw();scheduleAutoSave();
    message("仅恢复了同一 SHA 来源下的未认证草稿；请继续独立核对。",true);
  }catch(error){message("草稿来源或结构不符，已拒绝（"+(error instanceof GraphReviewError?error.code:"GRAPH_RESTORE_FAILED")+"）。");}
}
function exportDraft(){
  if(!view||!draft)return;
  try{
    const checked=currentParse(draft,view);
    const data=JSON.stringify(checked,null,2);
    if(new TextEncoder().encode(data).byteLength>MAX_REVIEW_BYTES)throw new GraphReviewError("GRAPH_REVIEW_TOO_LARGE");
    const url=URL.createObjectURL(new Blob([data],{type:"application/json"}));
    const link=el("a");link.href=url;link.download=useGeneric()?regionReviewDraftFilename(view):"P127-graph-review-DRAFT-UNATTESTED.json";
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
    message("已向浏览器发出私有草稿下载请求。请核实文件实际保存位置；不代表人工验收通过。",true);
  }catch{message("草稿导出失败，未标记任何内容已验证。");}
}
async function loadAutomatically(){
  if(!allowReviewSwitch())return;
  if(!hasLocalToken){
    message("当前地址没有本机自动导入权限；请使用启动命令输出的专用地址，或继续手动选择文件。");
    return;
  }
  const epoch=++loadEpoch;
  cancelAutoSave();resetEditTracking();
  if(bitmap){bitmap.close();bitmap=null;}
  view=null;draft=null;selected=null;$("work").hidden=true;$("export-panel").hidden=true;
  try{
    if(!crypto?.subtle)throw new GraphReviewError("GRAPH_BROWSER_SHA_UNAVAILABLE");
    message("正在经授权的本机回环接口读取三份 P127 证据并核验 SHA…");
    const bundle=await autoRequest("/api/private-graph/p127/bundle");
    if(epoch!==loadEpoch)return;
    const {result,manifest,crop,identity}=await verifyAutoGraphBundle(bundle);
    const blob=new Blob([crop],{type:"image/png"});
    const image=await createImageBitmap(blob);
    try{
      if(epoch!==loadEpoch)return;
      const validated=validateGraphReviewSource(result,manifest,
        {...identity,cropWidth:image.width,cropHeight:image.height});
      if(epoch!==loadEpoch)return;
      activeReviewKind="LEGACY_P127";activeItemId=null;
      view=validated;draft=createGraphReviewDraft(view);bitmap=image;selected=null;
      $("review-scope").textContent="当前审核：RB-PDF-13 · 物理 P127 · 既有专用草稿";
      const prior=await autoRequest("/api/private-graph/p127/draft");
      if(epoch!==loadEpoch)return;
      if(prior.draft!==null)draft=parseGraphReviewDraft(prior.draft,view);
      if(prior.revision!==null&&!/^[0-9a-f]{64}$/u.test(prior.revision))
        throw new GraphReviewError("PRIVATE_DRAFT_REVISION_INVALID");
      saveRevision=prior.revision;autoActive=true;
      $("work").hidden=false;$("export-panel").hidden=false;
      draw();render();
      saveStatus("已连接本机私有草稿"+(prior.draft?"（已恢复）":"（等待首次修改）"));
      message("已自动导入固定 P127 证据并通过 SHA/坐标检查；"+(prior.draft?"已恢复未认证草稿。":(validated.nodes.length+validated.edges.length)+" 项候选均待你人工审核。"),true);
    }finally{if(bitmap!==image)image.close();}
  }catch(error){
    autoActive=false;
    const code=error instanceof GraphReviewError?error.code:"GRAPH_AUTO_IMPORT_FAILED";
    message("自动导入已安全停止（"+code+"）。没有调用 GLM，也没有自动提交任何人工结论。");
    saveStatus("未连接／未保存");
  }
}

async function loadRegisteredRegion(item,staged=false){
  if(!allowReviewSwitch())return;
  if(!hasLocalToken||(!staged&&item.reviewKind!=="REGISTERED_REGION")||
     item.id==="RB-PDF-13:page-002-region-01")return;
  const epoch=++loadEpoch;
  cancelAutoSave();resetEditTracking();
  if(bitmap){bitmap.close();bitmap=null;}
  view=null;draft=null;selected=null;
  $("work").hidden=true;$("export-panel").hidden=true;
  try{
    message("正在校验"+(staged?"隔离待审":"已登记")+"区域 "+item.fixtureId+" · P"+item.sourcePhysicalPage1Based+" 的机器候选…");
    const bundle=await autoRequest((staged?"/api/private-graph/intake/staged/bundle?item=":
      "/api/private-graph/registered/bundle?item=")+encodeURIComponent(item.id));
    if(epoch!==loadEpoch)return;
    if(bundle.reviewKind!==(staged?"STAGED_REGION":"REGISTERED_REGION")||
       (staged&&bundle.registered!==false)||
       bundle.registration?.id!==item.id||
       bundle.registration?.fixtureId!==item.fixtureId||
       bundle.registration?.regionId!==item.regionId||
       bundle.registration?.physicalPage!==item.sourcePhysicalPage1Based||
       bundle.registration?.kind!=="REGISTERED_REGION")
      throw new GraphReviewError("GRAPH_REGISTERED_IDENTITY_INVALID");
    const {result,manifest,crop,identity}=await verifyAutoGraphBundle(bundle);
    const image=await createImageBitmap(new Blob([crop],{type:"image/png"}));
    try{
      if(epoch!==loadEpoch)return;
      const verified=validateRegionGraphCandidate(result,manifest,{
        ...identity,cropWidth:image.width,cropHeight:image.height
      },{
        fixtureId:bundle.registration.fixtureId,regionId:bundle.registration.regionId,
        sourcePhysicalPage1Based:bundle.registration.physicalPage,
        sourceRun:bundle.registration.sourceRun,provider:bundle.registration.provider,
        model:bundle.registration.model,attemptClass:bundle.registration.attemptClass,
        expectedCropSha256:bundle.registration.cropSha256,
        expectedResultSha256:bundle.registration.resultSha256
      });
      if(epoch!==loadEpoch)return;
      if(verified.nodes.length!==item.nodeCount||verified.edges.length!==item.edgeCount)
        throw new GraphReviewError("GRAPH_REGISTERED_COUNTS_INVALID");
      const saved=bundle.saved;
      if(!saved||typeof saved!=="object"||!Object.hasOwn(saved,"draft")||
         !(saved.revision===null||
           (typeof saved.revision==="string"&&/^[0-9a-f]{64}$/u.test(saved.revision)))||
         (saved.draft===null)!==(saved.revision===null))
        throw new GraphReviewError("GRAPH_REGISTERED_DRAFT_RECEIPT_INVALID");
      const restored=saved.draft===null?createRegionReviewDraft(verified):
        parseRegionReviewDraft(saved.draft,verified);
      if(epoch!==loadEpoch)return;
      activeReviewKind=staged?"STAGED_REGION":"REGISTERED_REGION";activeItemId=item.id;
      view=verified;draft=restored;bitmap=image;selected=null;
      saveRevision=saved.revision;autoActive=true;
      $("review-scope").textContent="当前审核："+item.fixtureId+
        " · 物理 P"+verified.physicalPage+" · "+item.regionId+
        " · "+(staged?"自动隔离待审（未登记）":"已登记")+" · 结果 SHA 绑定的私有未认证草稿";
      $("work").hidden=false;$("export-panel").hidden=false;
      draw();render();
      saveStatus("已连接本机私有区域草稿"+(saved.draft?"（已恢复）":"（等待首次修改）"));
      message("已核验本区域来源、节点与箭头映射；请逐条与原图核对。没有任何自动认证。",true);
    }finally{if(bitmap!==image)image.close();}
  }catch(e){
    autoActive=false;
    message("区域审核已阻止（"+
      (typeof e?.code==="string"&&/^[A-Z_]{5,80}$/u.test(e.code)?
       e.code:"GRAPH_REGISTERED_IMPORT_BLOCKED")+"）。未调用模型或修改原草稿。");
    saveStatus("区域审核未连接");
  }
}

let batchEpoch=0;
async function loadBatchPlan(){
  const epoch=++batchEpoch;
  const summary=$("batch-plan-state"),details=$("batch-plan-details");
  if(!hasLocalToken){
    summary.textContent="静态模式下不可访问私有识别计划";
    details.textContent="未授权；已调用 0 次。";return;
  }
  summary.textContent="正在核验已有裁剪 SHA 并计算零费用计划…";
  details.textContent="不会调用 GLM；不会保存授权或任务回执。";
  try{
    const p=await autoRequest("/api/private-graph/batch/plan");
    if(epoch!==batchEpoch)return;
    if(p?.schemaVersion!=="acs-offline-graph-batch-plan-v1"||
       p.authority!=="PREVIEW_ONLY_NO_PROVIDER_DISPATCH"||
       p.dispatchEnabled!==false||p.providerRequestsIssued!==0||
       p.needsExplicitPaidAuthorization!==true||p.priceEstimate!==null||
       typeof p.planSha256!=="string"||!/^[0-9a-f]{64}$/u.test(p.planSha256)||
       !p.counts||!Number.isSafeInteger(p.counts.discovered)||
       !Number.isSafeInteger(p.counts.eligible)||
       !Array.isArray(p.items)||p.items.length!==p.counts.eligible||
       !Array.isArray(p.exclusions)||p.exclusions.length+p.items.length!==p.counts.discovered)
      throw new GraphReviewError("BATCH_PLAN_RESPONSE_INVALID");
    summary.textContent="已发现 "+p.counts.discovered+" 个区域 · 需推理 "+
      p.counts.eligible+" · 已有图关系 "+p.counts.alreadyHasGraph;
    details.textContent="计划校验码："+p.planSha256.slice(0,16)+
      "… · 单次上限 "+p.maxRequests+" 张 · 待重新授权 "+
      p.counts.eligible+" 张 · 本轮实际付费调用 0 次。"+
      "识别费用未核实；计划不能执行。";
  }catch(e){
    if(epoch!==batchEpoch)return;
    summary.textContent="识别计划安全停止";
    details.textContent=e instanceof GraphReviewError?e.code:"BATCH_PLAN_UNAVAILABLE";
  }
}
$("refresh-batch-plan").addEventListener("click",()=>{void loadBatchPlan();});

const stagedLabels=Object.freeze({
  WAITING_FOR_REVIEW:"来源校验完成 · 等待人工审核",
  REVIEW_DRAFT_UNATTESTED:"私有未认证草稿 · 可继续审核"
});
const intakeLabels=Object.freeze({
  REGISTERED_PENDING_HUMAN_REVIEW:"已登记 · 等待人工复核",
  SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED:"模型来源核验通过 · 尚未批准登记",
  WAITING_FOR_EXPLICIT_PAID_AUTHORIZATION:"只有裁剪图片 · 未授权付费识别",
  PRIOR_ATTEMPT_UNCERTAIN_NO_REPLAY:"历史模型请求结果不确定 · 禁止重发",
  MODEL_RESULT_BLOCKED_MANUAL_INVESTIGATION:"模型输出残缺或来源不符 · 人工排查",
  MODEL_EVIDENCE_UNSAFE:"模型证据访问异常 · 安全阻断",
  SOURCE_BLOCKED:"原始图像/来源异常 · 安全阻断",
  LEGACY_P127_EVIDENCE_BLOCKED:"旧 P127 证据异常 · 需要人工排查"
});
let intakeEpoch=0;
async function loadIntakeOverview(){
  const epoch=++intakeEpoch;
  const summary=$("intake-summary"),list=$("intake-items");
  const workflow=$("review-progress-summary"),next=$("next-review");
  next.disabled=true;next.onclick=null;workflow.textContent="正在核验各区域草稿的已保存进度…";
  list.replaceChildren();
  if(!hasLocalToken){
    summary.textContent="静态模式下不可读取本机接收状态。";return;
  }
  summary.textContent="正在只读核查已有图关系和历史请求…";
  try{
    const doc=await autoRequest("/api/private-graph/intake/overview");
    if(epoch!==intakeEpoch)return;
    if(doc?.schemaVersion!=="acs-safe-graph-intake-overview-v1"||
       doc.authority!=="READ_ONLY_CANDIDATES_NO_DISPATCH"||
       doc.dispatchEnabled!==false||doc.providerRequestsIssuedThisRun!==0||
       doc.priceAuthorized!==false||doc.autoRegistered!==false||
       doc.autoVerified!==false||!Array.isArray(doc.items)||doc.items.length>32||
       !doc.counts||doc.counts.total!==doc.items.length||
       !["reviewable","awaitingAuthorization","registrationPending","blocked"]
         .every(k=>Number.isSafeInteger(doc.counts[k])&&doc.counts[k]>=0)||
       doc.counts.reviewable+doc.counts.awaitingAuthorization+
         doc.counts.registrationPending+doc.counts.blocked!==doc.counts.total)
      throw new GraphReviewError("GRAPH_INTAKE_RESPONSE_INVALID");
    const seen=new Set(),frag=document.createDocumentFragment();
    let eligibleRegions=0,completedDraftRegions=0,totalDecisions=0,reviewedDecisions=0;
    for(const item of doc.items){
      if(!item||typeof item.id!=="string"||!/^RB-PDF-(?:12|13):page-[0-9]{3}-region-[0-9]{2}$/u.test(item.id)||
         typeof item.fixtureId!=="string"||typeof item.regionId!=="string"||
         item.id!==item.fixtureId+":"+item.regionId||seen.has(item.id)||
         !Number.isSafeInteger(item.physicalPage)||item.physicalPage<1||
         !Object.hasOwn(intakeLabels,item.state)||item.graphVerified!==false||
         item.humanVerified!==false||item.dispatchEnabled!==false||
         item.providerRequestsIssuedThisRun!==0||
         !((item.nodeCount===null&&item.edgeCount===null)||
           (Number.isSafeInteger(item.nodeCount)&&item.nodeCount>=0&&item.nodeCount<=80&&
            Number.isSafeInteger(item.edgeCount)&&item.edgeCount>=0&&item.edgeCount<=120)))
        throw new GraphReviewError("GRAPH_INTAKE_ROW_INVALID");
      const eligible=item.state==="SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED"||
        item.state==="REGISTERED_PENDING_HUMAN_REVIEW";
      if(eligible){
        const expectedKind=item.state==="SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED"?
          "STAGED_REGION":null;
        if(!["LEGACY_P127","REGISTERED_REGION","STAGED_REGION"].includes(item.reviewKind)||
           (expectedKind!==null&&item.reviewKind!==expectedKind)||
           (item.state==="REGISTERED_PENDING_HUMAN_REVIEW"&&item.reviewKind==="STAGED_REGION")||
           !Number.isSafeInteger(item.reviewedCount)||item.reviewedCount<0||
           item.nodeCount===null||item.edgeCount===null||
           item.reviewedCount>item.nodeCount+item.edgeCount)
          throw new GraphReviewError("GRAPH_REVIEW_PROGRESS_INVALID");
        eligibleRegions++;
        totalDecisions+=item.nodeCount+item.edgeCount;
        reviewedDecisions+=item.reviewedCount;
        if(item.reviewedCount===item.nodeCount+item.edgeCount)completedDraftRegions++;
      }else if(item.reviewKind!==null||item.reviewedCount!==null){
        throw new GraphReviewError("GRAPH_REVIEW_UNAUTHORIZED_PROGRESS");
      }
      seen.add(item.id);
      const card=el("div","queue-item"),title=el("div","queue-label");
      title.append(el("b","",item.fixtureId+" · 物理 P"+item.physicalPage),
        el("small","",item.regionId));
      card.append(title,el("span","queue-status",intakeLabels[item.state]));
      if(item.state==="SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED"){
        if(!Object.hasOwn(stagedLabels,item.stageState)||item.stagedAvailable!==true)
          throw new GraphReviewError("GRAPH_STAGED_RESPONSE_INVALID");
        card.append(el("span","queue-status",stagedLabels[item.stageState]));
        const reviewButton=el("button","primary","进入隔离待审 · 未认证");
        reviewButton.type="button";
        reviewButton.addEventListener("click",()=>void loadRegisteredRegion({
          ...item,sourcePhysicalPage1Based:item.physicalPage,reviewKind:"STAGED_REGION"
        },true));
        card.append(reviewButton);
      }else if(item.stagedAvailable!==false || item.stageState!==null){
        throw new GraphReviewError("GRAPH_STAGED_UNAUTHORIZED");
      }
      if(eligible){
        card.append(el("span","queue-status","已保存草稿处理 "+
          item.reviewedCount+"/"+(item.nodeCount+item.edgeCount)+
          " 项 · 认证 0 项"));
        if(item.state==="REGISTERED_PENDING_HUMAN_REVIEW"){
          const open=el("button","primary","进入本区域审核");
          open.type="button";
          open.addEventListener("click",()=>item.reviewKind==="LEGACY_P127"?
            void loadAutomatically():void loadRegisteredRegion({
              ...item,sourcePhysicalPage1Based:item.physicalPage
            }));
          card.append(open);
        }
      }else if(item.nodeCount!==null)
        card.append(el("span","queue-status",item.nodeCount+
          " 节点 / "+item.edgeCount+" 关系 · 未认证"));
      frag.append(card);
    }
    if(!doc.items.length)
      frag.append(el("p","pathhelp","尚未发现支持范围内的图结果，未调用模型。"));
    const p=doc.progress;
    if(!p||p.authority!=="DRAFT_PROGRESS_ONLY_NOT_HUMAN_VERIFICATION"||
       p.certifiedRegions!==0||p.eligibleRegions!==eligibleRegions||
       p.completedDraftRegions!==completedDraftRegions||
       p.incompleteDraftRegions!==eligibleRegions-completedDraftRegions||
       p.totalDecisions!==totalDecisions||p.reviewedDecisions!==reviewedDecisions||
       !Number.isSafeInteger(p.totalDecisions)||p.totalDecisions<0||
       !(p.nextItemId===null||typeof p.nextItemId==="string"))
      throw new GraphReviewError("GRAPH_REVIEW_PROGRESS_RESPONSE_INVALID");
    const pending=doc.items.filter(x=>x.reviewKind!==null&&
      x.reviewedCount<x.nodeCount+x.edgeCount).sort((a,b)=>
      Number(b.reviewedCount>0)-Number(a.reviewedCount>0)||
      a.fixtureId.localeCompare(b.fixtureId)||a.physicalPage-b.physicalPage||
      a.regionId.localeCompare(b.regionId));
    const first=pending[0]??null;
    if(p.nextItemId!==(first?.id??null))
      throw new GraphReviewError("GRAPH_REVIEW_NEXT_ITEM_INVALID");
    if(first){
      next.disabled=false;
      // Prefer an *other* incomplete region when one exists, so a reviewer
      // is not sent back to the currently open incomplete book.
      next.onclick=()=>{
        const current=activeItemId??(activeReviewKind==="LEGACY_P127"&&view?
          "RB-PDF-13:page-002-region-01":null);
        const target=first.id===current?(pending[1]??first):first;
        return target.reviewKind==="LEGACY_P127"?
          void loadAutomatically():void loadRegisteredRegion({
            ...target,sourcePhysicalPage1Based:target.physicalPage
          },target.reviewKind==="STAGED_REGION");
      };
    }
    workflow.textContent="私有草稿已处理 "+reviewedDecisions+"/"+totalDecisions+
      " 项 · 涉及 "+eligibleRegions+" 个可审区域 · 全部标记 "+completedDraftRegions+
      " 个（仅草稿、认证 0 个）";
    list.replaceChildren(frag);
    summary.textContent="总计 "+doc.counts.total+
      " · 已登记可人工复核 "+doc.counts.reviewable+
      " · 待付费授权 "+doc.counts.awaitingAuthorization+
      " · 仅待登记 "+doc.counts.registrationPending+
      " · 异常 "+doc.counts.blocked+" · 新增模型调用 0";
  }catch(e){
    if(epoch!==intakeEpoch)return;
    list.replaceChildren();
    next.disabled=true;next.onclick=null;
    workflow.textContent="审核进度不可核验；已阻止自动导航。";
    summary.textContent="结果接收核验停止："+(e instanceof GraphReviewError?e.code:"GRAPH_INTAKE_UNAVAILABLE");
  }
}
$("refresh-intake").addEventListener("click",()=>{void loadIntakeOverview();});

let queueEpoch=0,previewEpoch=0;
function resetPreview(){
  ++previewEpoch;
  $("crop-preview").hidden=true;
  const c=$("crop-preview-canvas");c.width=0;c.height=0;
  $("crop-preview-status").textContent="尚未选择区域";
}
async function showCropPreview(item){
  const epoch=++previewEpoch;
  const panel=$("crop-preview"),status=$("crop-preview-status");
  panel.hidden=false;
  $("crop-preview-title").textContent=item.fixtureId+" · 物理 P"+item.sourcePhysicalPage1Based+" · "+item.regionId;
  status.textContent="正在读取本机原始局部图片并核对 SHA…";
  const canvas=$("crop-preview-canvas");canvas.width=0;canvas.height=0;
  try{
    const data=await autoRequest("/api/private-graph/crop?item="+encodeURIComponent(item.id));
    if(epoch!==previewEpoch)return;
    const verified=await verifyGraphCropPreview(data,item);
    if(epoch!==previewEpoch)return;
    const image=await createImageBitmap(new Blob([verified.bytes],{type:"image/png"}));
    try{
      if(epoch!==previewEpoch)return;
      if(image.width!==verified.width||image.height!==verified.height)
        throw new GraphReviewError("GRAPH_CROP_PREVIEW_DIMENSIONS_MISMATCH");
      const scale=Math.min(1,Math.sqrt(4_000_000/(image.width*image.height)));
      canvas.width=Math.max(1,Math.floor(image.width*scale));
      canvas.height=Math.max(1,Math.floor(image.height*scale));
      const ctx=canvas.getContext("2d");
      if(!ctx)throw new GraphReviewError("GRAPH_CROP_PREVIEW_CANVAS_UNAVAILABLE");
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      status.textContent="SHA、来源与图像尺寸校验通过 · 仅供查看（不代表图关系识别完成）";
    }finally{image.close();}
  }catch(e){
    if(epoch!==previewEpoch)return;
    canvas.width=0;canvas.height=0;
    status.textContent="预览已阻止："+(e instanceof GraphReviewError?e.code:"GRAPH_CROP_PREVIEW_FAILED");
  }
}
const evidenceLabels={
  GRAPH_READY_FOR_HUMAN_REVIEW:"图关系已存在 · 待人工复核",
  CROP_READY_NO_GRAPH:"局部图像已校验 · 尚无图关系候选",
  CROP_MISSING_OR_BLOCKED:"裁剪图缺失／SHA 或尺寸不匹配",
  GRAPH_EVIDENCE_BLOCKED:"模型结果或审阅草稿不一致 · 阻止导入",
};
async function loadQueue(){
  const epoch=++queueEpoch;
  resetPreview();
  const summary=$("queue-summary"),list=$("queue-items");
  list.replaceChildren();
  if(!hasLocalToken){summary.textContent="未启用自动导入权限；可使用下方手动选择。";return;}
  summary.textContent="正在核对私有证据目录（只读）…";
  try{
    const queue=await autoRequest("/api/private-graph/queue");
    if(epoch!==queueEpoch)return;
    if(queue?.schemaVersion!=="acs-private-graph-review-queue-v1"||
       queue.authority!=="DISCOVERY_ONLY_NOT_GROUND_TRUTH"||
       !Array.isArray(queue.items)||queue.items.length>32||
       !queue.counts||queue.counts.total!==queue.items.length)
      throw new GraphReviewError("GRAPH_QUEUE_RESPONSE_INVALID");
    const shown=new Set();
    const fragment=document.createDocumentFragment();
    const registered=await autoRequest("/api/private-graph/registry");
    if(epoch!==queueEpoch)return;
    if(registered?.schemaVersion!=="acs-trusted-graph-registration-v1"||
       registered.authority!=="REGISTERED_SOURCE_ONLY_NOT_GROUND_TRUTH"||
       !Array.isArray(registered.entries)||registered.entries.length>32)
      throw new GraphReviewError("GRAPH_REGISTRY_RESPONSE_INVALID");
    const known=new Map();
    for(const reg of registered.entries){
      if(!reg||typeof reg.id!=="string"||known.has(reg.id)||
         !["LEGACY_P127","REGISTERED_REGION"].includes(reg.reviewKind)||
         reg.graphVerified!==false||reg.humanVerified!==false)
        throw new GraphReviewError("GRAPH_REGISTRY_RESPONSE_INVALID");
      known.set(reg.id,reg);
    }
    for(const item of queue.items){
      if(!item||typeof item.id!=="string"||item.id.length>70||
         typeof item.fixtureId!=="string"||!["RB-PDF-12","RB-PDF-13"].includes(item.fixtureId)||
         !Number.isSafeInteger(item.sourcePhysicalPage1Based)||item.sourcePhysicalPage1Based<1||
         typeof item.regionId!=="string"||!/^(?:page-[0-9]{3}-region-[0-9]{2})$/u.test(item.regionId)||
         item.id!==item.fixtureId+":"+item.regionId||shown.has(item.id)||
         !Object.hasOwn(evidenceLabels,item.evidenceStatus)||
         typeof item.reviewable!=="boolean"||item.graphVerified!==false||item.humanVerified!==false)
        throw new GraphReviewError("GRAPH_QUEUE_ITEM_INVALID");
      shown.add(item.id);
      if(item.reviewable!==(item.evidenceStatus==="GRAPH_READY_FOR_HUMAN_REVIEW")||
         (item.reviewable && (
           !known.has(item.id) || known.get(item.id).reviewKind!==item.reviewKind ||
           known.get(item.id).fixtureId!==item.fixtureId ||
           known.get(item.id).regionId!==item.regionId ||
           known.get(item.id).sourcePhysicalPage1Based!==item.sourcePhysicalPage1Based ||
           (item.reviewKind==="LEGACY_P127"&&item.id!=="RB-PDF-13:page-002-region-01")||
           (item.reviewKind==="REGISTERED_REGION"&&item.id==="RB-PDF-13:page-002-region-01")
         )))
        throw new GraphReviewError("GRAPH_QUEUE_AUTHORITY_INVALID");
      const card=el("div","queue-item"),label=el("div","queue-label");
      label.append(el("b","",item.fixtureId+" · 物理 P"+item.sourcePhysicalPage1Based),
        el("small","",item.regionId));
      card.append(label,el("span","queue-status",evidenceLabels[item.evidenceStatus]));
      if(item.evidenceStatus==="CROP_READY_NO_GRAPH"||item.reviewable){
        const preview=el("button","crop-preview-button","查看局部图片");
        preview.type="button";
        preview.addEventListener("click",()=>{void showCropPreview(item);});
        card.append(preview);
      }
      if(item.reviewable){
        if(!Number.isSafeInteger(item.nodeCount)||!Number.isSafeInteger(item.edgeCount)||
           !Number.isSafeInteger(item.reviewedCount)||item.reviewedCount<0||
           item.reviewedCount>item.nodeCount+item.edgeCount)
          throw new GraphReviewError("GRAPH_QUEUE_COUNTS_INVALID");
        card.append(el("span","queue-status",item.nodeCount+" 节点 / "+item.edgeCount+
          " 关系 · 已审 "+item.reviewedCount+"/"+(item.nodeCount+item.edgeCount)));
        const button=el("button","primary",item.reviewKind==="LEGACY_P127"?
          "进入 P127 人工审核":"进入本区域图关系审核");
        button.type="button";
        button.addEventListener("click",()=>item.reviewKind==="LEGACY_P127"?
          void loadAutomatically():void loadRegisteredRegion(item));
        card.append(button);
      }
      fragment.append(card);
    }
    if(!queue.items.length)fragment.append(el("p","pathhelp","当前范围内没有已发现的区域证据，未发起任何新解析。"));
    list.replaceChildren(fragment);
    summary.textContent="已发现 "+queue.items.length+" 个区域 · 可审核 "+
      queue.counts.ready+" · 只有裁剪 "+queue.counts.cropOnly+
      " · 证据异常 "+queue.counts.blocked;
  }catch(e){
    if(epoch!==queueEpoch)return;
    list.replaceChildren();
    summary.textContent="队列加载被安全阻止："+(e instanceof GraphReviewError?e.code:"GRAPH_QUEUE_UNAVAILABLE");
  }
}

$("refresh-queue").addEventListener("click",()=>{void loadQueue();});
$("auto-load").addEventListener("click",()=>{void loadAutomatically();});
$("load").addEventListener("click",()=>{void load();});
$("clear").addEventListener("click",()=>reset(true));
for(const id of ["result-file","manifest-file","crop-file"]){
  $(id).addEventListener("change",()=>reset(false));
}
$("restore").addEventListener("change",()=>{void restoreDraft();});
$("export").addEventListener("click",exportDraft);

if(hasLocalToken){void loadBatchPlan();void loadIntakeOverview();void loadQueue();void loadAutomatically();}
