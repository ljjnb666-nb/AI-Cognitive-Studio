import React from "react";
import { statusTone } from "@/lib/studio-display";

export function StatusBadge({ value }: { value: string }) {
  const tone = statusTone(value);
  const dotClass = tone === "success" ? "success" : tone === "warning" ? "processing" : tone === "danger" ? "failed" : "queued";

  return (
    <span className="status-badge">
      <span className={`status-dot ${dotClass}`} aria-hidden="true" />
      <span>{value}</span>
    </span>
  );
}

export function IndeterminateProgressBar() {
  return (
    <div className="progress-bar-container" aria-label="处理中">
      <div className="progress-bar-indeterminate" />
    </div>
  );
}
