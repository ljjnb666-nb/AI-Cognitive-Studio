import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@ai-cognitive/db";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { GenerationProcessing } from "@/components/generation-processing";
import { resolveWebIdentity } from "@/lib/identity";
import { videoStageLabel, statusLabel } from "@/lib/product";

export default async function VideoDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await resolveWebIdentity();

  const project = await prisma.shortVideoProject.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
    include: {
      runs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          scenes: {
            orderBy: { ordinal: "asc" },
            include: {
              evidence: { include: { sourceBlock: true } },
            },
          },
        },
      },
      currentVideo: { include: { revision: true } },
      revisions: { orderBy: { revisionNumber: "desc" } },
    },
  });

  if (!project) notFound();

  const run = project.runs[0];
  const statusText = run
    ? run.status === "FAILED"
      ? "生成失败，可重新尝试"
      : videoStageLabel(run.stage) ?? statusLabel(run.status, run.errorCode)
    : "等待处理";

  return (
    <div>
      <PageHeader
        eyebrow="SHORT VIDEO PROJECT"
        title={project.name}
        description="基于原书理解生成的短视频"
        action={
          <Link className="btn btn-secondary" href="/studio/videos/new">
            重新生成
          </Link>
        }
      />

      {/* Generation Status Panel */}
      {run && (
        <section className="card-panel" style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <h2 className="section-title" style={{ fontSize: 16 }}>
              生成进度
            </h2>
            <StatusBadge value={statusText} />
          </div>
        </section>
      )}

      <GenerationProcessing status={run?.status ?? "QUEUED"} />

      {/* Video Player & Download */}
      {project.currentVideo && (
        <section className="card-panel" style={{ marginBottom: 32 }}>
          <h2 className="section-title" style={{ marginBottom: 16 }}>
            视频成片
          </h2>
          <video
            controls
            preload="metadata"
            src={`/api/studio/media/video/${project.currentVideo.revision.id}`}
            style={{ width: "100%", maxHeight: 540, borderRadius: 4, backgroundColor: "black" }}
          >
            你的浏览器不支持视频播放。
          </video>
          <div style={{ marginTop: 16 }}>
            <a
              href={`/api/studio/media/video/${project.currentVideo.revision.id}`}
              download
              className="btn btn-secondary"
              style={{ height: 36, fontSize: 13 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              下载 MP4
            </a>
          </div>
        </section>
      )}

      {/* Scene Structure: 观点 → 镜头 → 证据 → 成片 */}
      <section className="card-panel" style={{ marginBottom: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 24 }}>
          镜头与证据 (观点 → 镜头 → 证据 → 成片)
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {run?.scenes.map((scene) => (
            <div
              key={scene.id}
              style={{
                backgroundColor: "var(--surface-container)",
                border: "1px solid var(--surface-container-high)",
                borderRadius: "var(--radius-default)",
                padding: "20px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span className="meta-badge">{scene.sceneType}</span>
                <span className="font-mono" style={{ fontSize: 12, color: "var(--outline)" }}>
                  镜头 #{scene.ordinal + 1}
                </span>
              </div>
              <h3 className="font-serif" style={{ fontSize: 17, fontWeight: 600, color: "var(--on-surface)", margin: "0 0 8px 0" }}>
                {scene.primaryText}
              </h3>
              <p style={{ fontSize: 14, color: "var(--on-surface-variant)", margin: "0 0 12px 0", lineHeight: 1.6 }}>
                旁白: {scene.narrationText}
              </p>

              {scene.evidence.map((e) => {
                const excerpt = e.sourceBlock.text.slice(e.startOffset, e.endOffset) || e.sourceBlock.text;
                return (
                  <details key={e.id} style={{ fontSize: 13, color: "var(--outline)" }}>
                    <summary style={{ cursor: "pointer", userSelect: "none" }}>查看原文证据</summary>
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
          {!run?.scenes.length && (
            <p style={{ color: "var(--outline)", margin: 0, fontSize: 13 }}>暂无镜头信息。</p>
          )}
        </div>
      </section>

      {/* Video Revision History */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 16 }}>
          版本记录
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {project.revisions.map((x) => (
            <div key={x.id} className="font-mono" style={{ fontSize: 13, color: "var(--on-surface-variant)" }}>
              视频版本 #{x.revisionNumber} · {x.createdAt.toLocaleString("zh-CN")}
            </div>
          ))}
          {!project.revisions.length && (
            <p style={{ color: "var(--outline)", margin: 0, fontSize: 13 }}>暂无版本记录。</p>
          )}
        </div>
      </section>
    </div>
  );
}
