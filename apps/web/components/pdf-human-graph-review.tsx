"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "CONFIRM_STRUCTURE" | "REJECT_STRUCTURE" | "WITHDRAW";
type Props = {
  sourceDocumentId: string;
  candidateId: string;
  candidateSha256: string;
  previousEventId: string | null;
  previousAction: string | null;
  canDecide: boolean;
};

export function PdfHumanGraphReviewForm(props: Props) {
  const router = useRouter();
  const [compared,setCompared] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [saved,setSaved] = useState(false);
  async function submit(action: Action) {
    if (busy || !compared || !props.canDecide) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        "/api/studio/pdf-visual-review/" + props.sourceDocumentId + "/decision",
        {
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            candidateId:props.candidateId,
            candidateSha256:props.candidateSha256,
            previousEventId:props.previousEventId,
            action,comparedWithOriginalPdf:true,
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json() as {error?:string};
        throw new Error(body.error === "PDF_HUMAN_REVIEW_CONFLICT"
          ? "审核候选或审核状态已变化，请刷新页面再决定。"
          : "无法保存审核结论；请确认具有编辑权限且候选未过期。");
      }
      setCompared(false);
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败，请确认状态。");
    } finally { setBusy(false); }
  }
  const action=props.previousAction;
  return (
    <div style={{borderTop:"1px solid var(--outline-variant,#d4d4d4)",paddingTop:16,marginTop:16}}>
      <h3 style={{fontSize:17}}>人工图结构核验</h3>
      <p style={{fontSize:13}}>请在左侧原始 PDF 的对应物理页逐项检查图形区域、节点文字、箭头方向和关系。确认仅表示本次图结构比对结论，不是独立 Gold，也<strong>不批准用于播客</strong>。</p>
      {action ? <p role="status">当前审核决定：{action==="CONFIRM_STRUCTURE"?"已人工确认图结构":action==="REJECT_STRUCTURE"?"已人工驳回图结构":"已撤回，等待重新核对"}</p> : <p role="status">尚未记录人工决定</p>}
      {props.canDecide ? (
        <>
          <label style={{display:"flex",gap:9,alignItems:"flex-start",marginBottom:12}}>
            <input type="checkbox" checked={compared} onChange={e=>setCompared(e.target.checked)}/>
            我已实际对照该物理页的原始 PDF，而不是只看模型生成的文字或标签。
          </label>
          <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
            {action && action!=="WITHDRAW"
              ? <button type="button" className="btn btn-secondary" disabled={!compared||busy||saved} onClick={()=>void submit("WITHDRAW")}>撤回本次结论</button>
              : <>
                <button type="button" className="btn btn-secondary" disabled={!compared||busy||saved} onClick={()=>void submit("CONFIRM_STRUCTURE")}>确认图结构与原页一致</button>
                <button type="button" className="btn btn-secondary" disabled={!compared||busy||saved} onClick={()=>void submit("REJECT_STRUCTURE")}>驳回：图结构不准确</button>
              </>
            }
          </div>
        </>
      ) : <p>此工作区账号为只读权限，或审核候选已过期。无法提交或撤回结论。</p>}
      {saved ? <p role="status">审核记录已保存，正在刷新。不会自动进入播客。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
