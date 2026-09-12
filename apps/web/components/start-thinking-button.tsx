"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

function isThinkingHref(href: unknown): href is string {
  return typeof href === "string" && /^\/studio\/thinking\/[^/]+$/.test(href);
}

export function StartThinkingButton({ memoryItemId }: { memoryItemId: string }) {
  const router = useRouter();
  const pendingSessionId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    const sessionId = pendingSessionId.current ?? crypto.randomUUID();
    pendingSessionId.current = sessionId;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/studio/thinking-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memoryItemId, sessionId }) });
      const body = await response.json().catch(() => null) as { error?: string; href?: string; message?: string; pending?: boolean } | null;
      if (response.status === 202 || body?.pending) {
        setError("思考引导仍在生成中，请重试以继续。");
        return;
      }
      if (!response.ok && typeof body?.error === "string" && body.error.length > 0) {
        setError(body?.message ?? "暂时无法开始思考，请稍后重试。");
        pendingSessionId.current = null;
        return;
      }
      if (!response.ok || !isThinkingHref(body?.href)) {
        setError("服务器响应不完整，请重试以继续。");
        return;
      }
      pendingSessionId.current = null;
      router.push(body.href);
    } catch {
      setError("网络请求未完成，请重试以继续。");
    } finally {
      setBusy(false);
    }
  }

  return <div><button className="btn btn-primary" disabled={busy} onClick={() => void start()}>{busy ? "正在生成引导…" : "开始思考"}</button>{error ? <p role="alert">{error} <a href="/studio/settings/providers">前往 Provider 设置</a></p> : null}</div>;
}
