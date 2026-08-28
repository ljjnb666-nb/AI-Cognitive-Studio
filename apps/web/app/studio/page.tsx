import Link from "next/link";
import { dashboard, statusLabel } from "@/lib/product";
import { StatusBadge, IndeterminateProgressBar } from "@/components/status-badge";

export default async function StudioPage() {
  const data = await dashboard();
  const latestSource = data.sources[0];

  return (
    <div>
      {/* Home Hero: Current Analysis (当前分析) */}
      <section className="home-hero">
        <div>
          <div className="page-eyebrow">当前分析</div>
          <h1 className="page-title font-serif" style={{ fontSize: 44, marginBottom: 16 }}>
            {latestSource ? latestSource.title : "结构主义诗学"}
          </h1>
          <p className="page-desc" style={{ marginBottom: 28 }}>
            {latestSource
              ? latestSource.hasIntelligence
                ? "深度理解已完成。可以查看系统解读与原文证据，或继续生成播客和短视频。"
                : "正在解析与理解原始文本，提取结构与证据。"
              : "深度理解已完成。可以查看系统解读与原文证据，或继续生成播客和短视频。"}
          </p>

          <div style={{ display: "flex", gap: 12 }}>
            <Link
              href={latestSource ? `/studio/library/${latestSource.id}` : "/studio/library"}
              className="btn btn-primary"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              查看系统解读
            </Link>
            <Link
              href={latestSource ? `/studio/library/${latestSource.id}` : "/studio/library"}
              className="btn btn-secondary"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              原文证据
            </Link>
          </div>
        </div>

        {/* Featured Book Hero Card (Top-right) */}
        <div className="hero-book-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="font-mono" style={{ fontSize: 11, color: "var(--outline)", textTransform: "uppercase" }}>
              {latestSource?.mediaType || "EPUB"} / {latestSource ? (latestSource.hasIntelligence ? "解析完毕" : statusLabel(latestSource.status, latestSource.errorCode)) : "解析完毕"}
            </span>
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                backgroundColor: "var(--surface-container-highest)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>

          <h2 className="font-serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--on-surface)", margin: "24px 0 0 0" }}>
            {latestSource ? latestSource.title : "Structuralist Poetics"}
          </h2>
        </div>
      </section>

      <hr style={{ borderColor: "var(--surface-container-high)", margin: "0 0 48px 0", borderTop: "none" }} />

      {/* Section: Recent Activity (最近活动) */}
      <section>
        <div className="section-header">
          <h2 className="section-title">最近活动</h2>
          <Link href="/studio/activity" className="section-link font-mono">
            查看全部 →
          </Link>
        </div>

        <div className="cards-grid-3">
          {/* Card 1: Recent Podcast */}
          <div className="card-panel card-panel-interactive" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 180 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: "var(--surface-container-highest)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  </svg>
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--on-surface)" }}>播客生成完成</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--on-surface-variant)", margin: 0, lineHeight: 1.6 }}>
                {data.podcasts[0]
                  ? `“${data.podcasts[0].title}”播客已成功合成。`
                  : "“结构主义 Core 观点”播客已成功合成。"}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
              <span className="font-mono" style={{ fontSize: 11, color: "var(--outline)" }}>
                {data.podcasts[0]?.updatedAt ? new Date(data.podcasts[0].updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "最近"}
              </span>
              <Link href={data.podcasts[0]?.href || "/studio/podcasts"} style={{ fontSize: 12, color: "var(--on-surface)", fontWeight: 500 }}>
                播放
              </Link>
            </div>
          </div>

          {/* Card 2: Deep Analysis / Ingestion */}
          <div className="card-panel card-panel-interactive" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 180 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: "var(--surface-container-highest)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--on-surface)" }}>深度分析进行中</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--on-surface-variant)", margin: 0, lineHeight: 1.6 }}>
                {latestSource
                  ? `《${latestSource.title}》文本抽取与结构映射处理中。`
                  : "《人类简史》第五章文本抽取与结构映射处理中。"}
              </p>
            </div>
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span className="status-dot processing" />
                <span className="font-mono" style={{ fontSize: 11, color: "var(--outline)" }}>处理中</span>
              </div>
              <IndeterminateProgressBar />
            </div>
          </div>

          {/* Card 3: Document Import */}
          <div className="card-panel card-panel-interactive" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 180 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: "var(--surface-container-highest)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--on-surface)" }}>新文档导入</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--on-surface-variant)", margin: 0, lineHeight: 1.6 }}>
                {data.sources[1]
                  ? `“${data.sources[1].title}”已添加至知识库待处理队列。`
                  : "“认知心理学基础.pdf”已添加至知识库待处理队列。"}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
              <span className="font-mono" style={{ fontSize: 11, color: "var(--outline)" }}>
                {data.sources[1] ? new Date(data.sources[1].createdAt).toLocaleDateString("zh-CN") : "昨天"}
              </span>
              <Link href={data.sources[1] ? `/studio/library/${data.sources[1].id}` : "/studio/library"} style={{ fontSize: 12, color: "var(--on-surface)", fontWeight: 500 }}>
                查看
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
