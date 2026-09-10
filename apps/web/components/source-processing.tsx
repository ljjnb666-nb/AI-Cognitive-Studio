"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bookIntelligenceErrorMessage,
  needsProviderConfiguration,
} from "@/lib/product-errors";
import { processingCopy, processingWaitLabel, type ProcessingState, type ProcessingWorkerAvailability, type WorkerAvailability } from "@/lib/processing-state";

type Props = { sourceDocumentId: string; ingestionStatus?: string | null; analysisStatus?: string | null; errorCode?: string | null; processingState: string; workerAvailability: WorkerAvailability | ProcessingWorkerAvailability; processingSince?: string | null };

export function SourceProcessing({ sourceDocumentId, ingestionStatus, analysisStatus, errorCode, processingState, workerAvailability, processingSince }: Props) {
  const router = useRouter();
  const requested = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const terminal = processingState === "SUCCEEDED" || processingState.includes("FAILED") || processingState === "PROCESSING_DEGRADED";
  const requestAnalysis = useCallback(async (manual = false) => {
    if (!manual && requested.current) return;
    requested.current = true;
    try {
      const response = await fetch("/api/studio/book-intelligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDocumentId }) });
      setMessage(null);
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        const code = body.error ?? "BOOK_INTELLIGENCE_REQUEST_FAILED";
        setMessage(code);
        requested.current = false;
        return;
      }
      router.refresh();
    } catch {
      setMessage("BOOK_INTELLIGENCE_REQUEST_FAILED");
      requested.current = false;
    }
  }, [sourceDocumentId, router]);
  useEffect(() => { if (!terminal && ingestionStatus === "SUCCEEDED" && !analysisStatus) queueMicrotask(() => void requestAnalysis()); }, [analysisStatus, ingestionStatus, requestAnalysis, terminal]);
  useEffect(() => {
    if (terminal || message) return;
    let timer: number | undefined, delay = 2_000, stopped = false;
    const poll = () => { if (stopped || document.hidden) { timer = window.setTimeout(poll, 10_000); return; } router.refresh(); delay = Math.min(delay + 1_000, 10_000); timer = window.setTimeout(poll, delay); };
    timer = window.setTimeout(poll, delay);
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [message, router, terminal]);
  const [recovering, setRecovering] = useState(false);
  const recover = useCallback(async () => { if (recovering) return; setRecovering(true); try { const response = await fetch(`/api/studio/processing/${sourceDocumentId}/recover`, { method: "POST" }); if (!response.ok) { setMessage("PROCESSING_RECOVERY_FAILED"); return; } router.refresh(); } catch { setMessage("PROCESSING_RECOVERY_FAILED"); } finally { setRecovering(false); } }, [recovering, router, sourceDocumentId]);
  const failureCode = message ?? errorCode;
  const configurationError = needsProviderConfiguration(failureCode);
  if (analysisStatus === "FAILED") return <section className="panel"><p className="error">深度理解失败：{bookIntelligenceErrorMessage(errorCode)}</p><div className="actions">{configurationError && <Link className="button" href="/studio/settings/providers">配置 AI Provider</Link>}<button className="button secondary" aria-label="重试分析" onClick={() => void requestAnalysis(true)}>重试深度理解</button></div></section>;
  if (configurationError) return <section className="panel"><p>书籍解析完成。配置 AI Provider 后开始深度理解。</p><div className="actions"><Link className="button" href="/studio/settings/providers">配置 AI Provider</Link><button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></div></section>;
  if (message) return <section className="panel"><p className="error">{bookIntelligenceErrorMessage(message)}</p><button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></section>;
  const state = processingState as ProcessingState;
  const recovery = state === "NOT_STARTED" || state === "INGESTION_FAILED" || state === "PROCESSING_DEGRADED";
  const waiting = processingSince ? processingWaitLabel(new Date(processingSince)) : null;
  const stageAvailability = typeof workerAvailability === "string" ? workerAvailability : (analysisStatus ? workerAvailability.bookAnalysis : workerAvailability.ingestion);
  return <section className="panel"><p>{processingCopy[state] ?? "正在处理"}</p>{waiting && <p className="muted">{waiting}</p>}<p className="muted">后台自动处理，无需保持页面打开。{stageAvailability === "DEGRADED" ? " 后台处理服务未运行或暂时不可用。" : ""}</p><div className="actions"><button className="button secondary" onClick={() => router.refresh()}>重新检查状态</button>{recovery && <button className="button" disabled={recovering} onClick={() => void recover()}>{recovering ? "正在提交恢复…" : state === "NOT_STARTED" ? "开始处理" : "重试解析"}</button>}</div></section>;
}
