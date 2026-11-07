import { processingWorkerAvailability } from "@/lib/worker-heartbeat";
import { processingErrorType } from "@/lib/product-errors";
import { CancelJobButton } from "@/components/cancel-job-button";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@ai-cognitive/db";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { GenerationProcessing } from "@/components/generation-processing";
import { PodcastPlayer } from "@/components/podcast-player";
import { PodcastQualityFeedback } from "@/components/podcast-quality-feedback";
import { resolveWebIdentity } from "@/lib/identity";
import { generationStatusLabel } from "@/lib/product-labels";
import { betaTelemetryEnabledForUser } from "@ai-cognitive/product-analytics";

export default async function PodcastDetail({ params }: { params: Promise<{ episodeId: string }> }) {
  const { episodeId } = await params;
  const ctx = await resolveWebIdentity();
  const betaTelemetryEnabled = await betaTelemetryEnabledForUser(ctx.userId);

  const episode = await prisma.podcastEpisode.findFirst({
    where: { id: episodeId, workspaceId: ctx.workspaceId },
    include: {
      generationRuns: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          segments: {
            orderBy: { ordinal: "asc" },
            include: {
              utterances: {
                orderBy: { ordinal: "asc" },
                include: {
                  speaker: true,
                  evidence: { include: { sourceBlock: true } },
                },
              },
            },
          },
        },
      },
      audioGenerationRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { jobId: true, status: true, stage: true, errorCode: true } },
      currentScript: { include: { revision: true } },
      currentAudio: { include: { revision: true } },
      audioRevisions: { orderBy: { revisionNumber: "desc" } },
    },
  });

  if (!episode) notFound();

  const run = episode.generationRuns[0];
  const audioRun = episode.audioGenerationRuns[0];
  const scriptActive = run?.status === "QUEUED" || run?.status === "RUNNING";
  const worker = run?.status === "QUEUED" ? (await processingWorkerAvailability()).podcastGeneration : undefined;
  const statusText = generationStatusLabel({ kind:"podcast", status:run?.status ?? episode.status, stage:run?.stage ?? "QUEUED", hasScript:Boolean(episode.currentScript), hasArtifact:Boolean(episode.currentAudio), audioStatus:audioRun?.status, audioStage:audioRun?.stage });

  return (
    <div>
      {run && ["QUEUED", "RUNNING"].includes(run.status) && <CancelJobButton jobId={run.jobId} />}
      {audioRun && ["QUEUED", "RUNNING"].includes(audioRun.status) && <CancelJobButton jobId={audioRun.jobId} />}
      <PageHeader
        eyebrow="双人播客"
        title={episode.title}
        description="有证据支撑的多主持人对话"
        action={!scriptActive && (
          <Link className="btn btn-secondary" href="/studio/podcasts/new">
            重新生成
          </Link>
        )}
      />

      {/* Generation Status Panel */}
      {run && (
        <section className="card-panel" style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <h2 className="section-title" style={{ fontSize: 16 }}>
              生成进度
            </h2>
            <StatusBadge value={worker === "DEGRADED" ? "等待文稿服务" : statusText} />
          </div>
          <p style={{ fontSize: 13, color: "var(--outline)", margin: 0 }}>{run.status === "FAILED"
              ? `文稿生成失败。原因：${processingErrorType(run.errorCode)}。`
              : worker === "DEGRADED"
                ? "任务已排队，播客文稿后台服务暂不可用。服务恢复后会自动接单。"
                : worker === "UNKNOWN"
                  ? "任务已排队，暂时无法确认后台服务状态。页面会自动更新。"
                  : scriptActive
                    ? "页面会自动更新文稿生成进度。"
                    : "下方显示已保存的生成结果。"}</p>
        </section>
      )}

      <GenerationProcessing
        status={run?.status ?? "QUEUED"}
        episodeId={episode.id}
        hasScript={Boolean(episode.currentScript)}
        hasAudio={Boolean(episode.currentAudio)}
        audioStatus={audioRun?.status}
        audioErrorCode={audioRun?.errorCode}
      />

      {/* Audio Player & Download */}
      {episode.currentAudio && (
        <section className="card-panel" style={{ marginBottom: 32 }}>
          <h2 className="section-title" style={{ marginBottom: 16 }}>
            播放节目
          </h2>
          <PodcastPlayer revisionId={episode.currentAudio.revision.id} telemetryEnabled={betaTelemetryEnabled} />
          {betaTelemetryEnabled ? <PodcastQualityFeedback revisionId={episode.currentAudio.revision.id} /> : null}
          <div style={{ marginTop: 12 }}>
            <a
              href={`/api/studio/media/audio/${episode.currentAudio.revision.id}`}
              download
              className="btn btn-secondary"
              style={{ height: 36, fontSize: 13 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              下载音频
            </a>
          </div>
        </section>
      )}

      {/* Episode Script */}
      {episode.currentScript && (
        <section className="card-panel" style={{ marginBottom: 32 }}>
          <h2 className="section-title" style={{ marginBottom: 24 }}>
            节目文稿
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {run?.segments
              .flatMap((s) => s.utterances)
              .map((u) => (
                <div
                  key={u.id}
                  style={{
                    backgroundColor: "var(--surface-container)",
                    border: "1px solid var(--surface-container-high)",
                    borderRadius: "var(--radius-default)",
                    padding: "16px 20px",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)", marginBottom: 6 }}>
                    {u.speaker.displayName}
                  </div>
                  <p style={{ fontSize: 15, lineHeight: 1.7, color: "var(--on-surface)", margin: "0 0 12px 0" }}>
                    {u.text}
                  </p>
                  {u.evidence.map((e) => {
                    const excerpt = e.sourceBlock.text.slice(e.startOffset, e.endOffset) || e.sourceBlock.text;
                    return (
                      <details key={e.id} style={{ fontSize: 13, color: "var(--outline)" }}>
                        <summary style={{ cursor: "pointer", userSelect: "none" }}>查看引用证据</summary>
                        <blockquote
                          style={{
                            margin: "8px 0 0 0",
                            padding: "10px 14px",
                            backgroundColor: "var(--surface-container-lowest)",
                            borderLeft: "3px solid var(--outline-variant)",
                            fontSize: 13,
                            color: "var(--on-surface-variant)",
                          }}
                        >
                          “{excerpt}”
                        </blockquote>
                      </details>
                    );
                  })}
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Audio Revision History */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 16 }}>
          版本记录
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {episode.audioRevisions.map((x) => (
            <div key={x.id} className="font-mono" style={{ fontSize: 13, color: "var(--on-surface-variant)" }}>
              音频版本 #{x.revisionNumber} · {x.createdAt.toLocaleString("zh-CN")}
            </div>
          ))}
          {!episode.audioRevisions.length && (
            <p style={{ color: "var(--outline)", margin: 0, fontSize: 13 }}>暂无版本记录。</p>
          )}
        </div>
      </section>
    </div>
  );
}
