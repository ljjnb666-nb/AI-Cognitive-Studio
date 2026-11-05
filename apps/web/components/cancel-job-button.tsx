"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function CancelJobButton({ jobId }: { jobId: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const router = useRouter();
  return <><button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const response = await fetch(`/api/studio/jobs/${jobId}/cancel`, { method: "POST" }); if (!response.ok) throw new Error(); router.refresh(); } catch { setError("取消未完成，请刷新后重试。"); } finally { setBusy(false); } }}>{busy ? "正在取消…" : "取消任务"}</button>{error && <p role="alert">{error}</p>}</>;
}
