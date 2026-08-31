"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CompleteThinkingButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function complete() {
    if (busy) return;
    setBusy(true);
    setError("");
    const response = await fetch(`/api/studio/thinking-sessions/${sessionId}/complete`, { method: "POST" });
    setBusy(false);
    if (!response.ok) {
      setError("结束思考失败，请稍后重试。");
      return;
    }
    router.refresh();
  }

  return <section className="card-panel">
    <h2 className="section-title">结束本次思考</h2>
    <p>结束后会保留完整记录，并将会话设为只读。</p>
    <button className="btn btn-secondary" disabled={busy} onClick={() => void complete()}>
      {busy ? "正在结束…" : "结束思考"}
    </button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
