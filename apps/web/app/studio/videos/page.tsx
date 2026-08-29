import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { statusLabel, videoList } from "@/lib/product";

export default async function VideosPage() {
  const videos = await videoList();

  return (
    <div>
      <PageHeader
        title="短视频"
        description="从书中提炼观点、叙事与证据。"
        action={
          <Link className="btn btn-primary" href="/studio/videos/new">
            生成短视频
          </Link>
        }
      />

      <div className="cards-grid-2">
        {videos.map((v) => (
          <Link key={v.id} href={v.href} className="card-panel card-panel-interactive" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 140 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span className="font-mono" style={{ fontSize: 11, color: "var(--outline)", textTransform: "uppercase" }}>
                  SHORT VIDEO
                </span>
                <StatusBadge value={statusLabel(v.status, v.errorCode)} />
              </div>
              <h3 className="font-serif" style={{ fontSize: 18, fontWeight: 600, color: "var(--on-surface)", margin: 0 }}>
                {v.title}
              </h3>
            </div>
            <div style={{ fontSize: 12, color: "var(--outline)", marginTop: 16 }}>
              {new Date(v.createdAt).toLocaleDateString("zh-CN")}
            </div>
          </Link>
        ))}
      </div>

      {!videos.length && (
        <div className="card-panel" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p style={{ color: "var(--outline)", margin: 0, fontSize: 15 }}>
            暂无短视频项目。选择已完成理解的书，即可开始生成短视频。
          </p>
        </div>
      )}
    </div>
  );
}
