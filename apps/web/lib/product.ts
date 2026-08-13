import "server-only";

import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity, type WebIdentityContext } from "./identity";

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

export async function sources(context?: WebIdentityContext): Promise<SourceSummary[]> {
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
}

export async function dashboard(context?: WebIdentityContext) {
  const identity = context ?? await resolveWebIdentity();
  const [items, podcasts, videos, jobs] = await Promise.all([
    sources(identity),
    prisma.podcastEpisode.findMany({ where: { workspaceId: identity.workspaceId }, include: { generationRuns: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" }, take: 6 }),
    prisma.shortVideoProject.findMany({ where: { workspaceId: identity.workspaceId }, include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" }, take: 6 }),
    prisma.job.count({ where: { workspaceId: identity.workspaceId, status: "FAILED" } }),
  ]);
  return { sources: items, podcasts: podcasts.map((episode) => ({ id: episode.id, title: episode.title, kind: "podcast" as const, status: episode.generationRuns[0]?.status ?? episode.status, stage: episode.generationRuns[0]?.stage ?? "QUEUED", createdAt: episode.createdAt.toISOString(), updatedAt: episode.updatedAt.toISOString(), href: `/studio/podcasts/${episode.id}`, errorCode: episode.generationRuns[0]?.errorCode ?? undefined })), videos: videos.map((project) => ({ id: project.id, title: project.name, kind: "video" as const, status: project.runs[0]?.status ?? "QUEUED", stage: project.runs[0]?.stage ?? "QUEUED", createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), href: `/studio/videos/${project.id}`, errorCode: project.runs[0]?.errorCode ?? undefined })), failedJobs: jobs };
}

export async function sourceDetail(sourceDocumentId: string, context?: WebIdentityContext) {
  const identity = context ?? await resolveWebIdentity();
  const record = await prisma.sourceDocument.findFirst({
    where: { id: sourceDocumentId, workspaceId: identity.workspaceId },
    include: {
      source: true, ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      currentExtraction: { include: { extraction: { include: { structureNodes: { orderBy: { ordinal: "asc" } }, blocks: { orderBy: { ordinal: "asc" }, take: 40 } } } } },
      currentIntelligence: { include: { analysisRun: { include: { memoryItems: { include: { evidence: { include: { sourceBlock: true } } }, orderBy: { ordinal: "asc" }, take: 80 }, artifacts: { where: { scope: "BOOK" }, take: 1 } } } } },
    },
  });
  if (!record) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  return record;
}

export const podcastStageLabel: Record<string, string> = { QUEUED: "等待生成", EPISODE_PLANNING: "正在设计节目结构", NARRATIVE_DESIGN: "正在组织认知主线", SEGMENT_OUTLINE: "正在编排对话", SEGMENT_DRAFTING: "正在编排对话", HUMANIZATION: "正在润色表达", GROUNDING_VALIDATION: "正在检查引用", FINALIZING: "正在完成节目", COMPLETED: "完成", SPEECH_PREPARATION: "正在准备语音", UTTERANCE_SYNTHESIS: "正在生成语音", SEGMENT_ASSEMBLY: "正在合成音频", EPISODE_ASSEMBLY: "正在合成音频", AUDIO_NORMALIZATION: "正在进行质量检查", QUALITY_VALIDATION: "正在进行质量检查" };
export const videoStageLabel: Record<string, string> = { QUEUED: "等待生成", CONTEXT_RETRIEVAL: "正在提取相关知识", VIDEO_PLANNING: "正在确定视频观点", NARRATIVE_GENERATION: "正在设计叙事", SCENE_PLANNING: "正在拆分镜头", NARRATION_SYNTHESIS: "正在生成旁白", VISUAL_PREPARATION: "正在准备视觉", CAPTION_GENERATION: "正在生成字幕", VIDEO_RENDERING: "正在渲染视频", QUALITY_VALIDATION: "正在质量检查", FINALIZING: "正在完成视频", COMPLETED: "完成" };
