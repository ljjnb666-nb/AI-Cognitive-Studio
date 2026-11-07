import { readPublishedBookRevisionForRun } from "@ai-cognitive/book-intelligence";
import { sourceProcessingSnapshot, type ProcessingStatus } from "./processing-state";
import { processingWorkerAvailability } from "./worker-heartbeat";
import { generationStatusLabel } from "./product-labels";
import { prisma, Prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";
import { projectBookDisplay } from "./book-display";
import { statusLabel, podcastStageLabel, videoStageLabel } from "./product-labels";

export { statusLabel, podcastStageLabel, videoStageLabel };

export type SourceSummary = { id: string; title: string; titleOrigin: "WORK" | "FILENAME"; fileName: string; version: number; isLatestVersion: boolean; mediaType: string; createdAt: string; status: string; errorCode?: string; hasIntelligence: boolean; processing: ProcessingStatus };
export type GenerationSummary = { id: string; title: string; kind: "podcast" | "video"; status: string; stage: string; createdAt: string; updatedAt?: string; href: string; errorCode?: string; statusText: string };

export const asDate = (value: Date | null | undefined) => value?.toISOString() ?? null;

async function webIdentity(context?: WebIdentityContext): Promise<WebIdentityContext> {
  if (context) return context;
  const { resolveWebIdentity } = await import("./identity");
  return resolveWebIdentity();
}

export type ListQuery = { page?: number; pageSize?: number; lookahead?: boolean; q?: string; format?: string; status?: string };
async function sourceWindow(workspaceId: string, query: ListQuery) {
  const { take, skip } = window(query, 100);
  const formats: Record<string, string> = { PDF: "application/pdf", EPUB: "application/epub+zip", MD: "text/markdown", TXT: "text/plain" };
  const search = query.q?.trim().slice(0, 200) ?? "", mediaType = formats[query.format ?? ""];
  return prisma.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT state."id", state.status FROM (
      SELECT d."id", d."createdAt", CASE
        WHEN ci."extractionId"=ce."extractionId" THEN 'INTELLIGENCE_READY'
        WHEN ar."status"::text IN ('QUEUED','RUNNING','FAILED') THEN ar."status"::text
        WHEN ir."status"::text='SUCCEEDED' THEN 'INGESTED'
        ELSE COALESCE(ir."status"::text,'QUEUED') END AS status
      FROM "SourceDocument" d JOIN "Source" s ON s."id"=d."sourceId"
      LEFT JOIN "Edition" e ON e."id"=s."editionId"
      LEFT JOIN "Work" w ON w."id"=e."workId"
      LEFT JOIN "CurrentDocumentExtraction" ce ON ce."sourceDocumentId"=d."id" AND ce."workspaceId"=d."workspaceId"
      LEFT JOIN "CurrentBookIntelligence" ci ON ci."sourceDocumentId"=d."id" AND ci."workspaceId"=d."workspaceId"
      LEFT JOIN LATERAL (SELECT "status" FROM "IngestionRun" WHERE "sourceDocumentId"=d."id" AND "workspaceId"=d."workspaceId" ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) ir ON true
      LEFT JOIN LATERAL (SELECT "status" FROM "BookAnalysisRun" WHERE "sourceDocumentId"=d."id" AND "workspaceId"=d."workspaceId" AND "extractionId"=ce."extractionId" ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) ar ON true
      WHERE d."workspaceId"=${workspaceId} AND s."archivedAt" IS NULL
        AND (${!search} OR strpos(lower(s."displayName"),lower(${search}))>0 OR strpos(lower(w."title"),lower(${search}))>0)
        ${mediaType ? Prisma.sql`AND d."mediaType"=${mediaType}` : Prisma.empty}
    ) state WHERE true
      ${query.status === "SUCCEEDED" ? Prisma.sql`AND status='INTELLIGENCE_READY'` : query.status === "FAILED" ? Prisma.sql`AND status IN ('FAILED','REJECTED','OCR_REQUIRED','PASSWORD_REQUIRED')` : query.status === "PROCESSING" ? Prisma.sql`AND status IN ('QUEUED','RUNNING')` : Prisma.empty}
    ORDER BY state."createdAt" DESC,state."id" DESC LIMIT ${take} OFFSET ${skip}
  `);
}
function window(query: ListQuery, fallback: number) { const size = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? fallback))); const page = Math.min(10000, Math.max(1, Math.trunc(query.page ?? 1))); return { take: size + (query.lookahead ? 1 : 0), skip: (page - 1) * size }; }
export async function sources(context?: WebIdentityContext, query: ListQuery = {}): Promise<SourceSummary[]> {
  try {
    const identity = await webIdentity(context);
    const states = await sourceWindow(identity.workspaceId, query);
    const records = await prisma.sourceDocument.findMany({
      where: { workspaceId: identity.workspaceId, id: { in: states.map(row => row.id) } },
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
        ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true, routingPlan:true,routingOutcome:true,createdAt:true, startedAt:true } },
        currentIntelligence: { select: { id: true } },
        bookAnalysisBootstraps: { orderBy: { createdAt: "desc" }, take: 1, select: { status:true,errorCode:true,createdAt:true,startedAt:true,updatedAt:true } },
        analysisRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true, createdAt:true, startedAt:true, executionClaimedAt:true, job: { select: { createdAt:true, startedAt:true } } } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const workerAvailability = await processingWorkerAvailability();
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
      status: states.find(row => row.id === record.id)!.status,
      errorCode: sourceProcessingSnapshot({ ingestion:record.ingestionRuns[0],analysis:record.analysisRuns[0],bootstrap:record.bookAnalysisBootstraps[0],hasIntelligence:states.find(row=>row.id===record.id)!.status==="INTELLIGENCE_READY",workerAvailability }).errorCode ?? undefined,
      hasIntelligence: states.find(row => row.id === record.id)!.status === "INTELLIGENCE_READY",
      processing: sourceProcessingSnapshot({ ingestion:record.ingestionRuns[0],analysis:record.analysisRuns[0],bootstrap:record.bookAnalysisBootstraps[0],hasIntelligence:states.find(row=>row.id===record.id)!.status==="INTELLIGENCE_READY",workerAvailability }).processing,
    }));
  } catch {
    throw new Error("PRODUCT_LIST_LOAD_FAILED");
  }
}

export async function podcastList(context?: WebIdentityContext, query: ListQuery = {}): Promise<GenerationSummary[]> {
  try {
    const identity = await webIdentity(context);
    const episodes = await prisma.podcastEpisode.findMany({
      where: { workspaceId: identity.workspaceId },
      select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, generationRuns: { select: { status: true, stage: true, errorCode: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...window(query, 6),
    });
    return episodes.map((episode) => ({ id: episode.id, title: episode.title, kind: "podcast" as const, statusText:generationStatusLabel({kind:"podcast",status:episode.generationRuns[0]?.status??episode.status,stage:episode.generationRuns[0]?.stage??"QUEUED"}), status: episode.generationRuns[0]?.status ?? episode.status, stage: episode.generationRuns[0]?.stage ?? "QUEUED", createdAt: episode.createdAt.toISOString(), updatedAt: episode.updatedAt.toISOString(), href: `/studio/podcasts/${episode.id}`, errorCode: episode.generationRuns[0]?.errorCode ?? undefined }));
  } catch {
    throw new Error("PRODUCT_LIST_LOAD_FAILED");
  }
}

export async function videoList(context?: WebIdentityContext, query: ListQuery = {}): Promise<GenerationSummary[]> {
  try {
    const identity = await webIdentity(context);
    const projects = await prisma.shortVideoProject.findMany({
      where: { workspaceId: identity.workspaceId },
      select: { id: true, name: true, createdAt: true, updatedAt: true, runs: { select: { status: true, stage: true, errorCode: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...window(query, 6),
    });
    return projects.map((project) => ({ id: project.id, title: project.name, kind: "video" as const, statusText:generationStatusLabel({kind:"video",status:project.runs[0]?.status??"QUEUED",stage:project.runs[0]?.stage??"QUEUED"}), status: project.runs[0]?.status ?? "QUEUED", stage: project.runs[0]?.stage ?? "QUEUED", createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), href: `/studio/videos/${project.id}`, errorCode: project.runs[0]?.errorCode ?? undefined }));
  } catch {
    throw new Error("PRODUCT_LIST_LOAD_FAILED");
  }
}

export async function dashboard(context?: WebIdentityContext) {
  try {
    const identity = await webIdentity(context);
    const [items, podcasts, videos, jobs] = await Promise.all([
      sources(identity),
      podcastList(identity),
      videoList(identity),
      prisma.job.count({ where: { workspaceId: identity.workspaceId, status: "FAILED" } }),
    ]);
    return {
      sources: items,
      podcasts,
      videos,
      failedJobs: jobs,
    };
  } catch {
    throw new Error("DASHBOARD_LOAD_FAILED");
  }
}

export async function sourceDetail(sourceDocumentId: string, context?: WebIdentityContext, requestedTextPage = 1) {
  const identity = await webIdentity(context);
  const { record, bookSummary, bookPublicationId, bookMemories } = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const record = await tx.sourceDocument.findFirst({
    where: { id: sourceDocumentId, workspaceId: identity.workspaceId, source: { archivedAt: null } },
    include: {
      source: {
        include: {
          edition: { include: { work: true } },
          documents: { orderBy: [{ version: "desc" }, { createdAt: "desc" }], take: 1, select: { id: true } },
        },
      },
      ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      bookAnalysisBootstraps: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true, createdAt: true, startedAt: true, updatedAt: true } },
      analysisRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, jobId: true, status: true, analysisStage: true, extractionId: true, chunkSetId: true, errorCode: true, createdAt: true, startedAt: true, completedAt: true, executionLeaseUntil: true, executionClaimedAt: true, job: { select: { createdAt: true, startedAt: true } }, chunkSet: { select: { _count: { select: { chunks: true } } } }, _count: { select: { artifacts: { where: { scope: "CHUNK" } } } } } },
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
  const blockPagination = extraction?.status === "SUCCEEDED" && pages.length === 0 && extraction._count.blocks > 0;
  const pageCount = blockPagination ? Math.ceil(extraction._count.blocks / 40) : pages.length;
  const pageNumber = Math.min(Math.max(1, Number.isSafeInteger(requestedTextPage) ? requestedTextPage : 1), Math.max(1, pageCount));
  const page = pages[pageNumber - 1];
  const blocks = page || blockPagination ? await prisma.sourceBlock.findMany({ where: { extractionId: extraction!.id, ...(page ? { sourcePageId: page.id } : {}) }, orderBy: { ordinal: "asc" }, ...(blockPagination ? { skip: (pageNumber - 1) * 40 } : {}), take: blockPagination ? 40 : 41, select: { id: true, ordinal: true, text: true } }) : [];
  const textPreview = page || blockPagination ? { paginationKind: blockPagination ? "blocks" as const : "physical" as const, pageNumber, pageCount, physicalPageNumber: !page || page.physicalPageIndex === null ? null : page.physicalPageIndex + 1, truncated: blocks.length > 40 || blocks.some(block => block.text.length > 4000), blocks: blocks.slice(0, 40).map(block => ({ ...block, text: block.text.slice(0, 4000) })) } : null;
  const analysis = record.analysisRuns[0];
  const analysisProgress = analysis && analysis.extractionId === record.currentExtraction?.extractionId ? { runId: analysis.id, stage: analysis.analysisStage, completedChunks: analysis._count.artifacts, totalChunks: analysis.chunkSet._count.chunks } : null;
  return { ...record, textPreview, bookSummary, bookPublicationId, bookMemories, analysisProgress };
}