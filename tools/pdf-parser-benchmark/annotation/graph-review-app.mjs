import {
  MAX_RESULT_BYTES, MAX_MANIFEST_BYTES, MAX_CROP_BYTES, MAX_REVIEW_BYTES,
  validateGraphReviewSource, createGraphReviewDraft, parseGraphReviewDraft,
  updateGraphDecision, graphReviewProgress, GraphReviewError,
} from "./graph-review.mjs";
import { verifyAutoGraphBundle } from "./graph-review-auto.mjs";
import { verifyGraphCropPreview } from "./graph-crop-preview.mjs";

const $=id=>document.getElementById(id);
const el=(tag,klass,text)=>{
  const x=document.createElement(tag);if(klass)x.className=klass;
  if(text!==undefined)x.textContent=String(text);return x;
};
let view=null,draft=null,bitmap=null,selected=null,loadEpoch=0;
const token=new URLSearchParams(location.hash.slice(1)).get("review-token");
const hasLocalToken=typeof token==="string"&&/^[0-9a-f]{64}$/u.test(token);
let autoActive=false,saveRevision=null,saveTimer=null,saveQueue=Promise.resolve(),saveEpoch=0;
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
  if(!autoActive||!view||!draft)return;
  if(saveTimer!==null)clearTimeout(saveTimer);
  const epoch=saveEpoch;
  saveStatus("有待保存的修改");
  saveTimer=setTimeout(()=>{
    saveTimer=null;
    const stored=structuredClone(draft);
    const lineage=view.resultSha256;
    const next=saveQueue.then(async()=>{
      if(!autoActive||saveEpoch!==epoch||!view||view.resultSha256!==lineage)return;
      saveStatus("保存中…");
      try{
        const result=await autoRequest("/api/private-graph/p127/draft",{
          method:"PUT",
          headers:{"Content-Type":"application/json","x-acs-draft-revision":saveRevision??"none"},
          body:JSON.stringify(stored),
        });
        if(saveEpoch!==epoch||!autoActive||!view||view.resultSha256!==lineage)return;
        if(!/^[0-9a-f]{64}$/u.test(result.revision)||result.status!=="REVIEW_DRAFT_UNATTESTED")
          throw new GraphReviewError("PRIVATE_DRAFT_RECEIPT_INVALID");
        saveRevision=result.revision;
        saveStatus("已保存到本机 D 盘（未认证草稿）");
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
  ++loadEpoch;cancelAutoSave();
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
  const progress=graphReviewProgress(draft,view);
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
        draft=updateGraphDecision(draft,view,r.kind,r.id,select.value,select.value==="UNREVIEWED"?"":v.note);
        render();scheduleAutoSave();
        message("已更新本机草稿；"+(autoActive?"等待本机自动保存。":"请手动导出草稿。"),true);
      }catch{message("审阅状态不合法，未修改草稿。");render();}
    });
    lbl.append(select);item.append(lbl);
    const nlabel=el("label","","审阅备注（最多 280 字）");
    const field=el("input");field.type="text";field.maxLength=280;field.value=v.note;field.placeholder="例如：箭头尖端模糊，不可确定方向";
    field.disabled=v.decision==="UNREVIEWED";
    field.addEventListener("change",()=>{
      try{draft=updateGraphDecision(draft,view,r.kind,r.id,v.decision,field.value);render();scheduleAutoSave();message("已更新本机备注；"+(autoActive?"等待本机自动保存。":"请导出草稿。"),true);}
      catch{message("备注格式不合法，未保存。");render();}
    });
    nlabel.append(field);item.append(nlabel);fragment.append(item);
  }
  container.replaceChildren(fragment);
}
async function load(){
  cancelAutoSave();
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
      view=validated;draft=createGraphReviewDraft(view);bitmap=image;selected=null;
      $("work").hidden=false;$("export-panel").hidden=false;
      draw();render();message("SHA / 物理 P127 / 节点关系坐标校验通过。所有候选仍未审阅。",true);
    }finally{if(bitmap!==image)image.close();}
  }catch(error){
    const code=error instanceof GraphReviewError?error.code:"GRAPH_LOCAL_FILE_OR_IMAGE_BLOCKED";
    message("已拒绝导入（"+code+"）；未创建人工结论。");
  }
}
async function restoreDraft(){
  if(!view)return;
  const expectedEpoch=loadEpoch;
  const expectedSha=view.resultSha256;
  const f=$("restore").files?.[0];
  if(!f||f.size<8||f.size>MAX_REVIEW_BYTES){message("已有草稿文件无效或过大。");return;}
  try{
    const raw=parseJSON(await f.arrayBuffer());
    if(loadEpoch!==expectedEpoch||!view||view.resultSha256!==expectedSha)
      throw new GraphReviewError("GRAPH_RESTORE_STALE_SELECTION");
    draft=parseGraphReviewDraft(raw,view);
    selected=null;render();draw();scheduleAutoSave();
    message("仅恢复了同一 SHA 来源下的未认证草稿；请继续独立核对。",true);
  }catch(error){message("草稿来源或结构不符，已拒绝（"+(error instanceof GraphReviewError?error.code:"GRAPH_RESTORE_FAILED")+"）。");}
}
function exportDraft(){
  if(!view||!draft)return;
  try{
    const checked=parseGraphReviewDraft(draft,view);
    const data=JSON.stringify(checked,null,2);
    if(new TextEncoder().encode(data).byteLength>MAX_REVIEW_BYTES)throw new GraphReviewError("GRAPH_REVIEW_TOO_LARGE");
    const url=URL.createObjectURL(new Blob([data],{type:"application/json"}));
    const link=el("a");link.href=url;link.download="P127-graph-review-DRAFT-UNATTESTED.json";
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
    message("已向浏览器发出私有草稿下载请求。请核实文件实际保存位置；不代表人工验收通过。",true);
  }catch{message("草稿导出失败，未标记任何内容已验证。");}
}
async function loadAutomatically(){
  if(!hasLocalToken){
    message("当前地址没有本机自动导入权限；请使用启动命令输出的专用地址，或继续手动选择文件。");
    return;
  }
  const epoch=++loadEpoch;
  cancelAutoSave();
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
      view=validated;draft=createGraphReviewDraft(view);bitmap=image;selected=null;
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
         (item.reviewable&&item.id!=="RB-PDF-13:page-002-region-01"))
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
        const button=el("button","primary","进入 P127 人工审核");
        button.type="button";
        button.addEventListener("click",()=>void loadAutomatically());
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

if(hasLocalToken){void loadQueue();void loadAutomatically();}
