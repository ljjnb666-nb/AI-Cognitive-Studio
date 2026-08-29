import Link from "next/link";
import { prisma } from "@ai-cognitive/db";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { resolveWebIdentity } from "@/lib/identity";
import { statusLabel } from "@/lib/product";

const jobTypeLabels: Record<string, string> = {
  DOCUMENT_INGESTION: "文档解析与抽取",
  BOOK_INTELLIGENCE: "书籍深度理解分析",
  PODCAST_GENERATION: "播客文稿与编排生成",
  PODCAST_AUDIO_SYNTHESIS: "播客音频语音合成",
  SHORT_VIDEO_GENERATION: "短视频分镜与叙事生成",
  SHORT_VIDEO_TTS_SYNTHESIS: "短视频旁白语音合成",
};

export default async function ActivityPage() {
  const ctx = await resolveWebIdentity();
  const jobs = await prisma.job.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      type: true,
      status: true,
      error: true,
      updatedAt: true,
      podcastGenerationRun: { select: { episodeId: true } },
      shortVideoGenerationRun: { select: { shortVideoProjectId: true } },
      ingestionRun: { select: { sourceDocumentId: true } },
    },
  });

  return (
    <div>
      <PageHeader title="活动记录" description="处理过程与生成历史以持久化任务为准。" />

      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          任务历史记录
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {jobs.map((job) => {
            const link = job.podcastGenerationRun
              ? `/studio/podcasts/${job.podcastGenerationRun.episodeId}`
              : job.shortVideoGenerationRun
              ? `/studio/videos/${job.shortVideoGenerationRun.shortVideoProjectId}`
              : job.ingestionRun
              ? `/studio/library/${job.ingestionRun.sourceDocumentId}`
              : "/studio";
            const error = job.error as { code?: string } | null;
            const displayType = jobTypeLabels[job.type] ?? job.type;
            const statusText = statusLabel(job.status, error?.code);

            return (
              <Link
                key={job.id}
                href={link}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 18px",
                  backgroundColor: "var(--surface-container)",
                  border: "1px solid var(--surface-container-high)",
                  borderRadius: "var(--radius-default)",
                  transition: "border-color 0.15s ease",
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--on-surface)", marginBottom: 4 }}>
                    {displayType}
                  </div>
                  <div className="font-mono" style={{ fontSize: 12, color: "var(--outline)" }}>
                    {job.updatedAt.toLocaleString("zh-CN")}
                  </div>
                </div>
                <StatusBadge value={statusText} />
              </Link>
            );
          })}

          {!jobs.length && (
            <p style={{ color: "var(--outline)", margin: 0, fontSize: 14 }}>暂无任务记录。</p>
          )}
        </div>
      </section>
    </div>
  );
}
