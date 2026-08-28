import { prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";

export type SourceSummary = { id: string; title: string; mediaType: string; createdAt: string; status: string; errorCode?: string; hasIntelligence: boolean };
export type GenerationSummary = { id: string; title: string; kind: "podcast" | "video"; status: string; stage: string; createdAt: string; updatedAt?: string; href: string; errorCode?: string };

export const asDate = (value: Date | null | undefined) => value?.toISOString() ?? null;
export const statusLabel = (status: string, errorCode?: string | null) => {
  if (errorCode === "PASSWORD_REQUIRED" || status === "PASSWORD_REQUIRED") return "需要密码";
  if (errorCode === "OCR_REQUIRED" || status === "OCR_REQUIRED") return "需要 OCR";
  if (status === "SUCCEEDED" || status === "COMPLETED") return "理解完成";
  if (status === "FAILED" || status === "REJECTED") return "失败";
  if (status === "RUNNING") return "处理中";
  return "等待处理";
};

export const podcastStageLabel = (stage: string) => {
  if (stage === "COMPLETED") return "成片已就绪";
  if (stage === "SCRIPTING") return "脚本生成中";
  if (stage === "SYNTHESIZING") return "语音合成中";
  return "等待中";
};

export const videoStageLabel = (stage: string) => {
  if (stage === "COMPLETED") return "成片已就绪";
  if (stage === "SCRIPTING") return "分镜生成中";
  if (stage === "SYNTHESIZING") return "视频合成中";
  return "等待中";
};

export async function sources(context?: WebIdentityContext): Promise<SourceSummary[]> {
  try {
    const { resolveWebIdentity } = await import("./identity");
    const identity = context ?? await resolveWebIdentity();
    const records = await prisma.sourceDocument.findMany({
      where: { workspaceId: identity.workspaceId },
      include: {
        source: { select: { displayName: true } },
        ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true } },
        currentIntelligence: { select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return records.map((record) => ({
      id: record.id, title: record.source.displayName, mediaType: record.mediaType, createdAt: record.createdAt.toISOString(),
      status: record.ingestionRuns[0]?.status ?? "QUEUED", errorCode: record.ingestionRuns[0]?.errorCode ?? undefined,
      hasIntelligence: Boolean(record.currentIntelligence),
    }));
  } catch {
    return [];
  }
}

export async function dashboard(context?: WebIdentityContext) {
  try {
    const { resolveWebIdentity } = await import("./identity");
    const identity = context ?? await resolveWebIdentity();
    const [items, podcasts, videos, jobs] = await Promise.all([
      sources(identity),
      prisma.podcastEpisode.findMany({ where: { workspaceId: identity.workspaceId }, include: { generationRuns: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" }, take: 6 }).catch(() => []),
      prisma.shortVideoProject.findMany({ where: { workspaceId: identity.workspaceId }, include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" }, take: 6 }).catch(() => []),
      prisma.job.count({ where: { workspaceId: identity.workspaceId, status: "FAILED" } }).catch(() => 0),
    ]);
    return {
      sources: items,
      podcasts: podcasts.map((episode) => ({ id: episode.id, title: episode.title, kind: "podcast" as const, status: episode.generationRuns[0]?.status ?? episode.status, stage: episode.generationRuns[0]?.stage ?? "QUEUED", createdAt: episode.createdAt.toISOString(), updatedAt: episode.updatedAt.toISOString(), href: `/studio/podcasts/${episode.id}`, errorCode: episode.generationRuns[0]?.errorCode ?? undefined })),
      videos: videos.map((project) => ({ id: project.id, title: project.name, kind: "video" as const, status: project.runs[0]?.status ?? "QUEUED", stage: project.runs[0]?.stage ?? "QUEUED", createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), href: `/studio/videos/${project.id}`, errorCode: project.runs[0]?.errorCode ?? undefined })),
      failedJobs: jobs,
    };
  } catch {
    return { sources: [], podcasts: [], videos: [], failedJobs: 0 };
  }
}

export async function sourceDetail(sourceDocumentId: string, context?: WebIdentityContext) {
  const { resolveWebIdentity } = await import("./identity");
  const identity = context ?? await resolveWebIdentity();
  const record = await prisma.sourceDocument.findFirst({
    where: { id: sourceDocumentId, workspaceId: identity.workspaceId },
    include: {
      source: true, ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      analysisRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, analysisStage: true, errorCode: true } },
      currentExtraction: { include: { extraction: { include: { structureNodes: { orderBy: { ordinal: "asc" } }, blocks: { orderBy: { ordinal: "asc" }, take: 40 } } } } },
      currentIntelligence: { include: { analysisRun: { include: { memoryItems: { include: { evidence: { include: { sourceBlock: true } } }, orderBy: { ordinal: "asc" }, take: 80 }, artifacts: { where: { scope: "BOOK" }, take: 1 } } } } },
    },
  }).catch(() => null);
  if (!record) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  return record;
}
