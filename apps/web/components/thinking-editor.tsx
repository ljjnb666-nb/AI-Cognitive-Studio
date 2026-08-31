"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ThinkingEditor({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const router = useRouter();
  const pendingClientMessageId = useRef<string | null>(null);
  const pendingContent = useRef<string | null>(null);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if ((!content.trim() && !pendingContent.current) || busy) return;
    const clientMessageId = pendingClientMessageId.current ?? crypto.randomUUID();
    const submittedContent = pendingContent.current ?? content.trim();
    pendingClientMessageId.current = clientMessageId;
    pendingContent.current = submittedContent;
    setContent(submittedContent);
    setPending(true);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/studio/thinking-sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientMessageId, content: submittedContent }) });
      const body = await response.json().catch(() => null) as { error?: string; pending?: boolean } | null;
      if (response.status === 202 || body?.pending) {
        setError("回应仍在生成中，请使用相同内容重试。");
        return;
      }
      if (!response.ok) {
        setError(body?.error === "THINKING_SESSION_IDEMPOTENCY_CONFLICT" ? "这条回应已经提交，不能用不同内容重试。" : "回应未能提交，请稍后重试（内容已保留在编辑器中）。");
        return;
      }
      pendingClientMessageId.current = null;
      pendingContent.current = null;
      setPending(false);
      setContent("");
      router.refresh();
    } catch {
      setError("网络请求未完成，请稍后重试（内容已保留在编辑器中）。");
    } finally {
      setBusy(false);
    }
  }

  return <section className="card-panel"><h2 className="section-title">你的回应</h2><textarea aria-label="你的回应" value={content} disabled={disabled || busy || pending} maxLength={4000} onChange={event => setContent(event.target.value)} style={{ width: "100%", minHeight: 150, padding: 14, background: "transparent", color: "var(--on-surface)" }} />{pending ? <p>这条回应可能已经提交，重试期间暂不能修改。</p> : null}<div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}><span style={{ color: "var(--outline)", fontSize: 12 }}>{disabled ? "这次思考已结束，记录保持只读。" : `${content.length}/4000`}</span><button className="btn btn-primary" disabled={disabled || busy || (!pending && !content.trim())} onClick={() => void submit()}>{busy ? "正在回应…" : pending ? "重试回应" : "提交回应"}</button></div>{error ? <p role="alert">{error}</p> : null}</section>;
}
