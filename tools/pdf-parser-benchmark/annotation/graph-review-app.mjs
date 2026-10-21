import {
  MAX_RESULT_BYTES, MAX_MANIFEST_BYTES, MAX_CROP_BYTES, MAX_REVIEW_BYTES,
  validateGraphReviewSource, createGraphReviewDraft, parseGraphReviewDraft,
  updateGraphDecision, graphReviewProgress, GraphReviewError,
} from "./graph-review.mjs";

const $=id=>document.getElementById(id);
const el=(tag,klass,text)=>{
  const x=document.createElement(tag);if(klass)x.className=klass;
  if(text!==undefined)x.textContent=String(text);return x;
};
let view=null,draft=null,bitmap=null,selected=null,loadEpoch=0;
const options=[
  ["UNREVIEWED","未审阅"],["VISIBLE_MATCH","与可见图像一致（草稿）"],
  ["VISIBLE_MISMATCH","与可见图像不一致"],["UNCERTAIN","无法判断／局部图像不清晰"],
];
function message(text,good=false){$("notice").textContent=text;$("notice").classList.toggle("ok",good);}
function reset(){
  ++loadEpoch;if(bitmap){bitmap.close();bitmap=null;}
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
        render();message("已更新本机草稿；仍未认证、未存盘。",true);
      }catch{message("审阅状态不合法，未修改草稿。");render();}
    });
    lbl.append(select);item.append(lbl);
    const nlabel=el("label","","审阅备注（最多 280 字）");
    const field=el("input");field.type="text";field.maxLength=280;field.value=v.note;field.placeholder="例如：箭头尖端模糊，不可确定方向";
    field.disabled=v.decision==="UNREVIEWED";
    field.addEventListener("change",()=>{
      try{draft=updateGraphDecision(draft,view,r.kind,r.id,v.decision,field.value);render();message("已更新本机备注；请导出草稿。",true);}
      catch{message("备注格式不合法，未保存。");render();}
    });
    nlabel.append(field);item.append(nlabel);fragment.append(item);
  }
  container.replaceChildren(fragment);
}
async function load(){
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
  const f=$("restore").files?.[0];
  if(!f||f.size<8||f.size>MAX_REVIEW_BYTES){message("已有草稿文件无效或过大。");return;}
  try{
    const raw=parseJSON(await f.arrayBuffer());
    draft=parseGraphReviewDraft(raw,view);
    selected=null;render();draw();message("仅恢复了同一 SHA 来源下的未认证草稿；请继续独立核对。",true);
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
$("load").addEventListener("click",()=>{void load();});
$("clear").addEventListener("click",reset);
$("restore").addEventListener("change",()=>{void restoreDraft();});
$("export").addEventListener("click",exportDraft);
