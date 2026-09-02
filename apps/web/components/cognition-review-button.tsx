"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function CognitionReviewButton({ cognitionId }: { cognitionId: string }) {
  const router = useRouter(), [done, setDone] = useState(false), [pending, startTransition] = useTransition(), eventId = useRef<string | undefined>(undefined);
  function review() { startTransition(async () => {
    const submissionEventId = eventId.current ?? crypto.randomUUID();
    eventId.current = submissionEventId;
    try {
      const response = await fetch(`/api/studio/cognitions/${cognitionId}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: submissionEventId }) });
      if (response.ok) { eventId.current = undefined; setDone(true); router.refresh(); }
    } catch { /* Keep the same event ID for a user-initiated retry after a lost response. */ }
  }); }
  return <button type="button" className="btn btn-secondary" onClick={review} disabled={pending || done}>{pending ? "正在记录…" : done ? "已记录复习" : "标记已复习"}</button>;
}
