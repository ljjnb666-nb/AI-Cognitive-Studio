import { prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";
import { statusLabel, podcastStageLabel, videoStageLabel } from "./product-labels";

export { statusLabel, podcastStageLabel, videoStageLabel };

export type SourceSummary = { id: string; title: string; mediaType: string; createdAt: string; status: string; errorCode?: string; hasIntelligence: boolean };
export type GenerationSummary = { id: string; title: string; kind: "podcast" | "video"; status: string; stage: string; createdAt: string; updatedAt?: string; href: string; errorCode?: string };

export const asDate = (value: Date | null | undefined) => value?.toISOString() ?? null;

async function webIdentity(context?: WebIdentityContext): Promise<WebIdentityContext> {
  if (context) return context;
  const { resolveWebIdentity } = await import("./identity");
  return resolveWebIdentity();
}

export async function sources(context?: WebIdentityContext): Promise<SourceSummary[]> {
  try {
    const identity = await webIdentity(context);
    const records = await prisma.sourceDocument.findMany({
      where: { workspaceId: identity.workspaceId },
      select: {
        id: true,
        mediaType: true,
        createdAt: true,
        source: { select: { displayName: true } },
        ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true } },
        currentIntelligence: { select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
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

export async function podcastList(context?: WebIdentityContext): Promise<GenerationSummary[]> {
  try {
    const identity = await webIdentity(context);
    const episodes = await prisma.podcastEpisode.findMany({
      where: { workspaceId: identity.workspaceId },
      select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, generationRuns: { select: { status: true, stage: true, errorCode: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 6,
    });
    return episodes.map((episode) => ({ id: episode.id, title: episode.title, kind: "podcast" as const, status: episode.generationRuns[0]?.status ?? episode.status, stage: episode.generationRuns[0]?.stage ?? "QUEUED", createdAt: episode.createdAt.toISOString(), updatedAt: episode.updatedAt.toISOString(), href: `/studio/podcasts/${episode.id}`, errorCode: episode.generationRuns[0]?.errorCode ?? undefined }));
  } catch {
    return [];
  }
}

export async function videoList(context?: WebIdentityContext): Promise<GenerationSummary[]> {
  try {
    const identity = await webIdentity(context);
    const projects = await prisma.shortVideoProject.findMany({
      where: { workspaceId: identity.workspaceId },
      select: { id: true, name: true, createdAt: true, updatedAt: true, runs: { select: { status: true, stage: true, errorCode: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 6,
    });
    return projects.map((project) => ({ id: project.id, title: project.name, kind: "video" as const, status: project.runs[0]?.status ?? "QUEUED", stage: project.runs[0]?.stage ?? "QUEUED", createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), href: `/studio/videos/${project.id}`, errorCode: project.runs[0]?.errorCode ?? undefined }));
  } catch {
    return [];
  }
}

export async function dashboard(context?: WebIdentityContext) {
  try {
    const identity = await webIdentity(context);
    const [items, podcasts, videos, jobs] = await Promise.all([
      sources(identity),
      podcastList(identity),
      videoList(identity),
      prisma.job.count({ where: { workspaceId: identity.workspaceId, status: "FAILED" } }).catch(() => 0),
    ]);
    return {
      sources: items,
      podcasts,
      videos,
      failedJobs: jobs,
    };
  } catch {
    return { sources: [], podcasts: [], videos: [], failedJobs: 0 };
  }
}

export async function sourceDetail(sourceDocumentId: string, context?: WebIdentityContext) {
  const identity = await webIdentity(context);
  const record = await prisma.sourceDocument.findFirst({
    where: { id: sourceDocumentId, workspaceId: identity.workspaceId },
    include: {
      source: true, ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      bookAnalysisBootstraps: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true, createdAt: true, startedAt: true, updatedAt: true } },
      analysisRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, analysisStage: true, extractionId: true, chunkSetId: true, errorCode: true, createdAt: true, startedAt: true, completedAt: true, executionLeaseUntil: true } },
      currentExtraction: { include: { extraction: { include: { structureNodes: { orderBy: { ordinal: "asc" } }, blocks: { orderBy: { ordinal: "asc" }, take: 40 } } } } },
      currentIntelligence: { include: { analysisRun: { include: { memoryItems: { include: { evidence: { include: { sourceBlock: true } } }, orderBy: { ordinal: "asc" }, take: 80 }, artifacts: { where: { scope: "BOOK" }, take: 1 } } } } },
    },
  }).catch(() => null);
  if (!record) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  return record;
}
