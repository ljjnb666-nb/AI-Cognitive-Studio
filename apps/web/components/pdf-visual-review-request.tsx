"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type RunStatus = "PENDING"|"RUNNING"|"SUCCEEDED"|"NO_FIGURES"|"FAILED"|"EXPIRED"|"INTERRUPTED";
type State = { enabled: boolean; candidatePhysicalPageIndex: number|null; request: { status: RunStatus; failureCode: string|null }|null };
type Props = { sourceDocumentId: string; serverEnabled: boolean };

const copy: Record<RunStatus,string> = {
  PENDING: "请求已记录，正在等待已授权的后台 Worker。",
  RUNNING: "视觉模型调用处理中。刷新页面不会重复申请。",
  SUCCEEDED: "图表候选已生成。请前往对应的混排物理页，与原始 PDF 对照复核（结果不自动发布）。",
  NO_FIGURES: "本次混排页未取得有效图表结构候选；不能推断原页为空白。",
  FAILED: "视觉识别未完成或结果需人工检查；为防止重复付费不会自动重试。",
  EXPIRED: "申请已过期且未执行；不会自动重试。",
  INTERRUPTED: "运行中断或结果尚未确认。不能自动重试付费模型。",
};

export function PdfVisualReviewRequestForm({ sourceDocumentId, serverEnabled }: Props) {
  const router = useRouter();
  const [allowImage, setAllowImage] = useState(false);
  const [allowCharges, setAllowCharges] = useState(false);
  const [state, setState] = useState<State|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const url = "/api/studio/pdf-visual-review/" + sourceDocumentId;
  const refresh = useCallback(async () => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("STATUS_UNAVAILABLE");
    const body = await response.json() as State;
    setState(body);
    return body;
  }, [url]);
  useEffect(() => {
    let disposed = false;
    const timeout = window.setTimeout(() => {
      void refresh().then(x => { if (!disposed && x.request?.status === "SUCCEEDED") router.refresh(); })
        .catch(() => { if (!disposed) setError("状态暂时无法读取，请稍后重新打开页面。"); });
    }, 0);
    return () => { disposed = true; window.clearTimeout(timeout); };
  }, [refresh,router]);
  useEffect(() => {
    const status = state?.request?.status;
    if (status !== "PENDING" && status !== "RUNNING") return;
    let disposed = false;
    const timer = window.setInterval(() => {
      if (disposed || document.hidden) return;
      void refresh().then(next => {
        if (!disposed && next.request?.status === "SUCCEEDED") router.refresh();
      }).catch(() => {
        if (!disposed) setError("暂时无法读取任务状态。");
      });
    }, 3500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [state?.request?.status, refresh, router]);
  async function submit() {
    if (!serverEnabled || !allowImage || !allowCharges || busy || state?.request) return;
    setBusy(true);
    setError(null);
    try {
      const response=await fetch(url,{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          mode:"FIRST_MIXED_PAGE",
          consentToExternalImageProcessing:true,
          consentToProviderCharges:true,
        }),
      });
      if (!response.ok) {
        const v=await response.json() as {error?:string};
        const mapped:Record<string,string>={
          PDF_VISUAL_PROVIDER_NOT_CONFIGURED:"请先在 Provider 设置中配置支持图片输入的视觉模型路由。",
          PDF_VISUAL_REQUEST_ALREADY_EXISTS:"已有申请。不能重复付费提交，请刷新状态。",
          PDF_VISUAL_REQUEST_DISABLED:"后台尚未启用按需视觉审核。",
        };
        throw new Error(mapped[v.error ?? ""] ?? "提交失败，未确认已创建新任务。");
      }
      setAllowImage(false);
      setAllowCharges(false);
      await refresh();
    } catch(e) {
      setError(e instanceof Error ? e.message : "提交失败，请核实任务状态。");
    } finally { setBusy(false); }
  }
  const active=Boolean(state?.request);
  return (
    <section className="card-panel" aria-labelledby="visual-request-title" style={{marginBottom:20}}>
      <h2 id="visual-request-title" style={{fontSize:18,marginTop:0}}>按需视觉识别 · 需要明确同意</h2>
      <p>仅尝试识别<strong>本书最前面的 1 张图文混排页</strong>，不保证是当前页，也不提供任意指定页识别。结果只是待复核的图表候选，不改变书籍正文或播客。</p>
      <p>使用已配置的外部视觉模型时，该页图片可能发送给模型服务商，并可能产生 API 费用。每个解析版本仅允许申请一次，不会自动重试。</p>
      {!serverEnabled || state?.enabled === false ? (
        <p role="status">此部署尚未启用混合页按需图结构识别。需要部署者明确设置开关并配置视觉 Provider 后才能提交。</p>
      ) : active ? (
        <div role="status">
          <strong>{copy[state!.request!.status]}</strong>
          {state!.request!.status === "SUCCEEDED" && Number.isSafeInteger(state?.candidatePhysicalPageIndex) && state!.candidatePhysicalPageIndex !== null ? (
            <p><Link className="btn btn-secondary" href={"/studio/library/" + sourceDocumentId + "/review?page=" + state!.candidatePhysicalPageIndex}>查看识别结果：PDF 物理第 {state!.candidatePhysicalPageIndex + 1} 页</Link></p>
          ) : null}
          {state!.request!.failureCode ? <p>状态码：{state!.request!.failureCode}</p> : null}
        </div>
      ) : (
        <div style={{display:"grid",gap:12}}>
          <label><input type="checkbox" checked={allowImage} onChange={e=>setAllowImage(e.target.checked)}/> 我同意将本书首张混排页的图片发送至已配置的外部视觉服务处理。</label>
          <label><input type="checkbox" checked={allowCharges} onChange={e=>setAllowCharges(e.target.checked)}/> 我理解此操作可能产生 Provider API 费用，且每个解析版本限一次。</label>
          <button type="button" className="btn btn-secondary" disabled={!allowImage||!allowCharges||busy} onClick={()=>void submit()}>
            {busy?"提交中…":"同意并申请识别首张混排页"}
          </button>
        </div>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {active ? <p style={{fontSize:12,marginBottom:0}}>状态来自后台数据库，重新打开页面不会重新申请。当前没有自动批准或发布按钮。</p> : null}
    </section>
  );
}
