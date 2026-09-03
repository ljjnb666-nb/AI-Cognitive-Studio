"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bookIntelligenceErrorMessage,
  needsProviderConfiguration,
} from "@/lib/product-errors";

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
  const failureCode = message ?? errorCode;
  const configurationError = needsProviderConfiguration(failureCode);
  if (analysisStatus === "FAILED") return <section className="panel"><p className="error">{bookIntelligenceErrorMessage(errorCode)}</p><div className="actions">{configurationError && <Link className="button" href="/studio/settings/providers">配置 Provider</Link>}<button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></div></section>;
  if (configurationError) return <section className="panel"><p>{bookIntelligenceErrorMessage(failureCode)}</p><div className="actions"><Link className="button" href="/studio/settings/providers">配置 Provider</Link><button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></div></section>;
  if (message) return <section className="panel"><p className="error">{bookIntelligenceErrorMessage(message)}</p><button className="button secondary" onClick={() => void requestAnalysis(true)}>重试分析</button></section>;
  return null;
}
