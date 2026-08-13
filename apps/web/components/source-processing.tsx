"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Props = { sourceDocumentId: string; ingestionStatus: string; analysisStatus?: string; errorCode?: string | null };

export function SourceProcessing({ sourceDocumentId, ingestionStatus, analysisStatus, errorCode }: Props) {
  const router = useRouter();
  const requested = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const terminal = Boolean(errorCode) || analysisStatus === "SUCCEEDED" || analysisStatus === "FAILED";
  useEffect(() => {
    if (terminal) return;
    if (ingestionStatus === "SUCCEEDED" && !analysisStatus && !requested.current) {
      requested.current = true;
      void fetch("/api/studio/book-intelligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDocumentId }) })
        .then(async (response) => { if (!response.ok) setMessage((await response.json() as { error?: string }).error ?? "BOOK_INTELLIGENCE_REQUEST_FAILED"); router.refresh(); })
        .catch(() => setMessage("BOOK_INTELLIGENCE_REQUEST_FAILED"));
    }
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [analysisStatus, ingestionStatus, router, sourceDocumentId, terminal]);
  if (terminal && !message) return null;
  return <p className="muted" aria-live="polite">{message ? `Intelligence request pending: ${message}` : ingestionStatus === "SUCCEEDED" ? "Creating a traceable Book Intelligence analysis…" : "Waiting for parsing to complete; this page updates automatically."}</p>;
}
