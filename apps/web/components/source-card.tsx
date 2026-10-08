import Link from "next/link";
import { StatusBadge, IndeterminateProgressBar } from "./status-badge";

type Props = {
  id: string;
  title: string;
  titleOrigin: "WORK" | "FILENAME";
  fileName: string;
  version: number;
  isLatestVersion: boolean;
  mediaType: string;
  createdAt: string;
  status: string;
  errorCode?: string;
  hasIntelligence: boolean;
  statusText: string;
};

export function SourceCard({ id, title, titleOrigin, fileName, version, isLatestVersion, mediaType, createdAt, statusText }: Props) {
  const formatBadge = (mediaType || "DOCUMENT")
    .replace("application/pdf", "PDF")
    .replace("application/epub+zip", "EPUB")
    .replace("text/markdown", "MD")
    .replace("text/plain", "TXT")
    .toUpperCase();

  const isProcessing = statusText === "处理中";

  return (
    <Link href={`/studio/library/${id}`} className="card-panel card-panel-interactive" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 180 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <span className="meta-badge">{formatBadge}</span>
          <StatusBadge value={statusText} />
        </div>
        <h3 className="font-serif" style={{ fontSize: 18, fontWeight: 600, color: "var(--on-surface)", margin: "0 0 12px 0", lineHeight: 1.4 }}>
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
        <div style={{ fontSize: 12, color: "var(--outline)", marginTop: 12 }}>
          {new Date(createdAt).toLocaleDateString("zh-CN")}
        </div>
        {isProcessing && <IndeterminateProgressBar />}
      </div>
    </Link>
  );
}