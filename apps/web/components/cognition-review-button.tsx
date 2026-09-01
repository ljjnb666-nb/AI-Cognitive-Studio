"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function CognitionReviewButton({ cognitionId }: { cognitionId: string }) {
  const router = useRouter(), [done, setDone] = useState(false), [pending, startTransition] = useTransition();
  function review() { startTransition(async () => { const response = await fetch(`/api/studio/cognitions/${cognitionId}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: crypto.randomUUID() }) }); if (response.ok) { setDone(true); router.refresh(); } }); }
  return <button type="button" className="btn btn-secondary" onClick={review} disabled={pending || done}>{pending ? "正在记录…" : done ? "已记录复习" : "标记已复习"}</button>;
}
