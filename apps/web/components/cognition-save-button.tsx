"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function CognitionSaveButton({ cognitionId, initialSaved }: { cognitionId: string; initialSaved: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initialSaved);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !saved;
    startTransition(async () => {
      const response = await fetch(`/api/studio/cognitions/${cognitionId}/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ saved: next }),
      });
      if (!response.ok) return;
      setSaved(next);
      router.refresh();
    });
  }

  return (
    <button type="button" className="btn btn-secondary" onClick={toggle} disabled={pending} aria-pressed={saved}>
      {pending ? "正在收藏…" : saved ? "已收藏" : "收藏认知"}
    </button>
  );
}
