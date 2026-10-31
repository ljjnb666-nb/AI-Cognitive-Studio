"use client";
import {useState} from "react";
import {useRouter} from "next/navigation";
type Props={sourceDocumentId:string;ingestionRunId:string;physicalPageIndex:number;receiptId:string;textSha256:string;sourcePdfSha256:string;enabled:boolean;existingStatus:string|null;existingJobId:string|null};
export function OcrModelReviewRequest(props:Props) {
 const router=useRouter();const [consent,setConsent]=useState(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
 async function submit(){setBusy(true);try{const result=await fetch(`/api/studio/pdf-visual-review/${props.sourceDocumentId}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ingestionRunId:props.ingestionRunId,physicalPageIndex:props.physicalPageIndex,receiptId:props.receiptId,textSha256:props.textSha256,sourcePdfSha256:props.sourcePdfSha256,consent:"send-one-original-page-and-ocr-to-workspace-vision-model-v1",...(props.existingStatus==="FAILED"?{previousFailedJobId:props.existingJobId}:{})})});if(!result.ok)throw Error();setConsent(false);setMessage("一次性审核请求已保存，请稍后刷新查看结果。");router.refresh();}catch{setMessage("未能创建审核请求，请检查权限、来源和视觉模型配置。");}finally{setBusy(false);}}
 return <section className="card-panel"><h2>独立模型审核</h2>
  <p>比较原始页面与 OCR 输出，检查遗漏、阅读顺序、表格、图表、公式及臆造内容。通过仍不等于 Gold 或播客发布授权。</p>
  <p>发送到已配置的工作区视觉模型（智谱 GLM 4.6V），最多一次调用、8 MB 页图、1600 输出 token；可能收费，金额尚未定价，用量留档。</p>
  {props.existingStatus?<p role="status">审核任务：{props.existingStatus}。不自动重试；运行未结束或结果不确定时需核对账本。</p>:null}
  {props.existingStatus==="FAILED"?<p>上次未得到可用判断，可能已经收费。核对账本后，可另行授权一次新调用；原失败记录保留。</p>:null}
  {!props.existingStatus||props.existingStatus==="FAILED"?<>
   <label><input type="checkbox" checked={consent} disabled={!props.enabled||busy} onChange={event=>setConsent(event.target.checked)}/>我授权发送此原书物理页的图片与 OCR 文本给工作区视觉模型，并同意上述一次性调用和用量限制。</label>
   <button type="button" className="btn btn-primary" disabled={!props.enabled||!consent||busy} onClick={()=>void submit()}>{busy?"正在提交…":props.existingStatus==="FAILED"?"另行授权一次模型审核":"请求模型审核此页"}</button>
  </>:null}
  {!props.enabled?<p>当前环境未开启按需视觉审核。</p>:null}<p role="status">{message}</p>
 </section>;
}
