"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Props = { sourceDocumentId: string; ingestionStatus?: string | null; analysisStatus?: string | null; errorCode?: string | null };

export function SourceProcessing({ sourceDocumentId, ingestionStatus, analysisStatus, errorCode }: Props) {
  const router = useRouter();
  const requested = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const terminal = Boolean(errorCode) || analysisStatus === "SUCCEEDED" || analysisStatus === "FAILED";
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
    const timer = window.setInterval(() => router.refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [message, router, terminal]);
  const configurationError = message === "AI_PROVIDER_CONFIGURATION_REQUIRED" || message === "BOOK_ROUTE_IDENTITY_INCONSISTENT" || errorCode === "AI_PROVIDER_CONFIGURATION_REQUIRED";
  if (analysisStatus === "FAILED") return <section className="panel"><p className="error">深度理解失败{errorCode ? `：${errorCode}` : "。"}</p><div className="actions">{configurationError && <Link className="button" href="/studio/settings/providers">配置 AI Provider</Link>}<button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></div></section>;
  if (configurationError) return <section className="panel"><p>书籍解析完成。配置 AI Provider 后开始深度理解。</p><div className="actions"><Link className="button" href="/studio/settings/providers">配置 AI Provider</Link><button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></div></section>;
  if (message) return <section className="panel"><p className="error">深度理解请求失败：{message}</p><button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></section>;
  return null;
}
