import { readPublishedBookRevisionForRun } from "@ai-cognitive/book-intelligence";
import { Prisma, prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";
import { projectBookDisplay } from "./book-display";
import { statusLabel, podcastStageLabel, videoStageLabel } from "./product-labels";

export { statusLabel, podcastStageLabel, videoStageLabel };

export type SourceSummary = { id: string; title: string; titleOrigin: "WORK" | "FILENAME"; fileName: string; version: number; isLatestVersion: boolean; mediaType: string; createdAt: string; status: string; errorCode?: string; hasIntelligence: boolean };
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
        version: true,
        createdAt: true,
        source: {
          select: {
            displayName: true,
            edition: { select: { work: { select: { title: true } } } },
            documents: { orderBy: [{ version: "desc" }, { createdAt: "desc" }], take: 1, select: { id: true } },
          },
        },
        ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true } },
        currentIntelligence: { select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return records.map((record) => ({
      id: record.id,
      ...projectBookDisplay({
        fileName: record.source.displayName,
        workTitle: record.source.edition?.work.title,
        version: record.version,
        isLatestVersion: record.source.documents[0]?.id === record.id,
      }),
      mediaType: record.mediaType,
      createdAt: record.createdAt.toISOString(),
      status: record.ingestionRuns[0]?.status ?? "QUEUED",
      errorCode: record.ingestionRuns[0]?.errorCode ?? undefined,
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

export async function sourceDetail(sourceDocumentId: string, context?: WebIdentityContext, requestedTextPage = 1) {
  const identity = await webIdentity(context);
  const { record, bookSummary, bookPublicationId, bookMemories } = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const record = await tx.sourceDocument.findFirst({
    where: { id: sourceDocumentId, workspaceId: identity.workspaceId },
    include: {
      source: {
        include: {
          edition: { include: { work: true } },
          documents: { orderBy: [{ version: "desc" }, { createdAt: "desc" }], take: 1, select: { id: true } },
        },
      },
      ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      bookAnalysisBootstraps: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true, createdAt: true, startedAt: true, updatedAt: true } },
      analysisRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, analysisStage: true, extractionId: true, chunkSetId: true, errorCode: true, createdAt: true, startedAt: true, completedAt: true, executionLeaseUntil: true } },
      currentExtraction: { include: { extraction: { include: { _count: { select: { pages: true, blocks: true } }, pages: { orderBy: { ordinal: "asc" }, select: { id: true, physicalPageIndex: true } }, structureNodes: { orderBy: { ordinal: "asc" } }, blocks: { orderBy: { ordinal: "asc" }, take: 40 } } } } },
      currentIntelligence: { include: { analysisRun: { include: { memoryItems: { include: { evidence: { include: { sourceBlock: true } } }, orderBy: { ordinal: "asc" }, take: 80 }, artifacts: { where: { scope: "BOOK" }, take: 1 } } } } },
    },
    });
    if (!record) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
    const marker = record.currentIntelligence;
    const current = marker && record.currentExtraction?.extractionId === marker.extractionId ? marker : null;
    const publication = current ? await readPublishedBookRevisionForRun(tx, current) : null;
    const revision = publication?.revision;
    const originals = current?.analysisRun.memoryItems ?? [];
    const changes = new Map(revision?.memories.map(memory => [memory.id, memory]));
    const visible = new Set(originals.map(memory => memory.id));
    const extraIds = [...changes.keys()].filter(id => !visible.has(id));
    const extra = extraIds.length ? await tx.bookMemoryItem.findMany({
      where: { analysisRunId: current!.analysisRunId, workspaceId: identity.workspaceId, id: { in: extraIds } },
      include: { evidence: { include: { sourceBlock: true } } }, orderBy: { ordinal: "asc" },
    }) : [];
    const displayed = [...originals, ...extra];
    const sourceIds = [...new Set(displayed.flatMap(memory => changes.get(memory.id)?.addedEvidence.map(span => span.sourceBlockId) ?? []))];
    const blocks = sourceIds.length ? await tx.sourceBlock.findMany({
      where: { extractionId: current!.extractionId, id: { in: sourceIds } },
    }) : [];
    const byBlock = new Map(blocks.map(block => [block.id, block]));
    const bookMemories = displayed.map(memory => {
      const change = changes.get(memory.id);
      const evidence = memory.evidence.map(({ id, sourceBlock, startOffset, endOffset }) => ({ id, sourceBlock, startOffset, endOffset }));
      for (const span of change?.addedEvidence ?? []) {
        if (evidence.some(item => item.sourceBlock.id === span.sourceBlockId && item.startOffset === span.startOffset && item.endOffset === span.endOffset)) continue;
        const sourceBlock = byBlock.get(span.sourceBlockId);
        if (!sourceBlock) throw new Error("BOOK_REVISION_EVIDENCE_INVALID");
        evidence.push({ ...span, sourceBlock, id: `${publication?.publicationId}:${memory.id}:${span.sourceBlockId}:${span.startOffset}:${span.endOffset}` });
      }
      return { id: memory.id, type: memory.type, ordinal: memory.ordinal, content: change?.after ?? memory.content, evidence };
    });
    return { record, bookMemories, bookPublicationId: publication?.publicationId ?? null,
      bookSummary: revision?.summary.after ?? current?.analysisRun.artifacts[0]?.summary ?? null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  // Preview only the owner's current published extraction, independently of AI
  // memories. Never read unpublished candidates or another document's pages.
  const extraction = record.currentExtraction?.extraction;
  const pages = extraction?.status === "SUCCEEDED" ? extraction.pages : [];
  const pageNumber = Math.min(Math.max(1, Number.isSafeInteger(requestedTextPage) ? requestedTextPage : 1), Math.max(1, pages.length));
  const page = pages[pageNumber - 1];
  const blocks = page ? await prisma.sourceBlock.findMany({ where: { extractionId: extraction!.id, sourcePageId: page.id }, orderBy: { ordinal: "asc" }, take: 41, select: { id: true, ordinal: true, text: true } }) : [];
  const textPreview = page ? { pageNumber, pageCount: pages.length, physicalPageNumber: page.physicalPageIndex === null ? null : page.physicalPageIndex + 1, truncated: blocks.length > 40 || blocks.some(block => block.text.length > 4000), blocks: blocks.slice(0, 40).map(block => ({ ...block, text: block.text.slice(0, 4000) })) } : null;
  return { ...record, textPreview, bookSummary, bookPublicationId, bookMemories };
}