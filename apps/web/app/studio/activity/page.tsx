import Link from "next/link";
import { prisma } from "@ai-cognitive/db";
import { PageHeader, Status } from "@/components/app-shell";
import { resolveWebIdentity } from "@/lib/identity";
import { statusLabel } from "@/lib/product";

export default async function Activity() {
  const ctx = await resolveWebIdentity();
  const jobs = await prisma.job.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { updatedAt: "desc" }, take: 100, include: { podcastGenerationRun: true, shortVideoGenerationRun: true, ingestionRun: true } });
  return <><PageHeader title="任务记录" description="处理过程与生成历史以持久化任务为准。"/><section className="panel"><h2>全部任务</h2>{jobs.map(job => {
    const link = job.podcastGenerationRun ? `/studio/podcasts/${job.podcastGenerationRun.episodeId}` : job.shortVideoGenerationRun ? `/studio/videos/${job.shortVideoGenerationRun.shortVideoProjectId}` : job.ingestionRun ? `/studio/library/${job.ingestionRun.sourceDocumentId}` : "/studio";
    const error = job.error as { code?: string } | null;
    return <Link className="list-row" href={link} key={job.id}><span><strong>{job.type}</strong><small>{job.updatedAt.toLocaleString("zh-CN")}</small></span><Status value={statusLabel(job.status, error?.code)}/></Link>;
  })}{!jobs.length && <p className="muted">暂无任务记录。</p>}</section></>;
}
