import Link from "next/link";
import { StatusBadge, IndeterminateProgressBar } from "./status-badge";
import type { SourceSummary } from "@/lib/product";
import { processingDisplay } from "@/lib/processing-display";

type Props = SourceSummary & { onDelete?: () => void };

export function SourceCard({ id, title, titleOrigin, fileName, version, isLatestVersion, mediaType, createdAt, processing, errorCode, onDelete }: Props) {
  const formatBadge = (mediaType || "DOCUMENT")
    .replace("application/pdf", "PDF")
    .replace("application/epub+zip", "EPUB")
    .replace("text/markdown", "MD")
    .replace("text/plain", "TXT")
    .toUpperCase();

  const display = processingDisplay(processing, errorCode);

  return (
    <article className="card-panel card-panel-interactive" style={{ display: "flex", flexDirection: "column", minHeight: 180 }}>
    <Link href={`/studio/library/${id}`} title={title} style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "space-between", color: "inherit", textDecoration: "none" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <span className="meta-badge">{formatBadge}</span>
          <StatusBadge value={display.label} tone={display.tone} />
        </div>
        <h3 className="font-serif" style={{ fontSize: 18, fontWeight: 600, color: "var(--on-surface)", margin: "0 0 12px 0", lineHeight: 1.4, overflowWrap: "anywhere" }}>
          {title}
        </h3>
        {titleOrigin === "WORK" && (
          <div style={{ color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>
            原文件：{fileName}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
          文件版本 v{version}{isLatestVersion ? "" : " · 历史版本（书名显示当前正式记录）"}
        </div>
      </div>
      <div>
        <p className="source-card-description">{display.description}</p>
        {processing.stage === "BOOK_ANALYSIS" && <span className="source-extracted-label">✓ 正文已提取</span>}
        <div style={{ fontSize: 12, color: "var(--outline)", marginTop: 12 }}>
          {new Date(createdAt).toLocaleDateString("zh-CN")}
        </div>
        {display.active && <IndeterminateProgressBar />}
      </div>
    </Link>
    {onDelete && <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}><button type="button" className="btn btn-secondary" onClick={onDelete} aria-label={`删除《${title}》`} style={{ height: 32, fontSize: 12, color: "var(--error, #a33932)" }}>删除</button></div>}
    </article>
  );
}
