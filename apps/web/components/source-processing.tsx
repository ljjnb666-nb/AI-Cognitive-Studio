"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bookIntelligenceErrorMessage,
  needsProviderConfiguration,
} from "@/lib/product-errors";
import { submitProcessingRecovery } from "@/lib/processing-recovery";
import { processingCopy, processingWaitLabel, type ProcessingStage, type ProcessingState, type ProcessingWorkerAvailability, type RecoveryAction, type WorkerAvailability } from "@/lib/processing-state";

type Props = { sourceDocumentId: string; ingestionStatus?: string | null; analysisStatus?: string | null; errorCode?: string | null; processingState: string; processingStage: ProcessingStage; recoveryAction: RecoveryAction; stageAvailability: WorkerAvailability; workerAvailability: WorkerAvailability | ProcessingWorkerAvailability; processingSince?: string | null };

export function SourceProcessing({ sourceDocumentId, ingestionStatus, analysisStatus, errorCode, processingState, processingStage: _processingStage, recoveryAction, stageAvailability, workerAvailability: _workerAvailability, processingSince }: Props) {
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
  const recover = useCallback(async () => { if (recovering) return; setRecovering(true); try { const result = await submitProcessingRecovery(sourceDocumentId); if (result !== "RECOVERED") { setMessage(result); return; } router.refresh(); } finally { setRecovering(false); } }, [recovering, router, sourceDocumentId]);
  const failureCode = message ?? errorCode;
  const configurationError = needsProviderConfiguration(failureCode);
  if (message) return <section className="panel"><p className="error">{configurationError ? "书籍解析完成。配置 AI Provider 后开始深度理解。" : bookIntelligenceErrorMessage(message)}</p><div className="actions">{configurationError && <Link className="button" href="/studio/settings/providers">配置 AI Provider</Link>}<button className="button secondary" disabled={recovering} onClick={() => void recover()}>{recovering ? "正在提交恢复…" : "恢复深度理解"}</button></div></section>;
  const state = processingState as ProcessingState;
  const recovery = recoveryAction !== "NONE" && recoveryAction !== "RECHECK";
  // This label is relative to the current clock, so its text can legitimately
  // differ by a second between SSR and hydration while durable state is equal.
  const waiting = processingSince ? processingWaitLabel(new Date(processingSince)) : null;
  const recoveryCopy = recoveryAction === "RETRY_INGESTION" ? (state === "NOT_STARTED" ? "开始处理" : "重新解析") : "恢复深度理解";
  return <section className="panel"><p>{configurationError ? "书籍解析完成。配置 AI Provider 后开始深度理解。" : processingCopy[state] ?? "正在处理"}</p>{waiting && <p className="muted" suppressHydrationWarning>{waiting}</p>}<p className="muted">后台自动处理，无需保持页面打开。{stageAvailability === "DEGRADED" ? " 后台处理服务未运行或暂时不可用。" : ""}</p><div className="actions">{configurationError && <Link className="button" href="/studio/settings/providers">配置 AI Provider</Link>}<button className="button secondary" onClick={() => router.refresh()}>重新检查状态</button>{recovery && <button className="button" disabled={recovering} onClick={() => void recover()}>{recovering ? "正在提交恢复…" : recoveryCopy}</button>}</div></section>;
}
