import React from "react";

export function StatusBadge({ value }: { value: string }) {
  let dotClass = "queued";
  if (value === "理解完成" || value === "解析完毕" || value === "完成" || value === "已就绪" || value === "已启用") {
    dotClass = "success";
  } else if (value === "处理中" || value.includes("正在") || value.includes("生成中")) {
    dotClass = "processing";
  } else if (value === "失败" || value.includes("失败") || value === "未完成" || value === "已停用") {
    dotClass = "failed";
  }

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
