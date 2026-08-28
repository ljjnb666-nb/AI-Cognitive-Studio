import Link from "next/link";
import { StatusBadge, IndeterminateProgressBar } from "./status-badge";

type Props = {
  id: string;
  title: string;
  mediaType: string;
  createdAt: string;
  status: string;
  errorCode?: string;
  hasIntelligence: boolean;
  statusText: string;
};

export function SourceCard({ id, title, mediaType, createdAt, hasIntelligence, statusText }: Props) {
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
