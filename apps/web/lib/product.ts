import { prisma, Prisma } from "@ai-cognitive/db";
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
      WHERE d."workspaceId"=${workspaceId}
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
        ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true } },
        currentIntelligence: { select: { id: true } },
        analysisRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, errorCode: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      status: states.find(row => row.id === record.id)!.status,
      errorCode: record.analysisRuns[0]?.errorCode ?? record.ingestionRuns[0]?.errorCode ?? undefined,
      hasIntelligence: states.find(row => row.id === record.id)!.status === "INTELLIGENCE_READY",
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
    return episodes.map((episode) => ({ id: episode.id, title: episode.title, kind: "podcast" as const, status: episode.generationRuns[0]?.status ?? episode.status, stage: episode.generationRuns[0]?.stage ?? "QUEUED", createdAt: episode.createdAt.toISOString(), updatedAt: episode.updatedAt.toISOString(), href: `/studio/podcasts/${episode.id}`, errorCode: episode.generationRuns[0]?.errorCode ?? undefined }));
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
    return projects.map((project) => ({ id: project.id, title: project.name, kind: "video" as const, status: project.runs[0]?.status ?? "QUEUED", stage: project.runs[0]?.stage ?? "QUEUED", createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), href: `/studio/videos/${project.id}`, errorCode: project.runs[0]?.errorCode ?? undefined }));
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
  const record = await prisma.sourceDocument.findFirst({
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
      analysisRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, jobId: true, status: true, analysisStage: true, extractionId: true, chunkSetId: true, errorCode: true, createdAt: true, startedAt: true, completedAt: true, executionLeaseUntil: true } },
      currentExtraction: { include: { extraction: { include: { _count: { select: { pages: true, blocks: true } }, pages: { orderBy: { ordinal: "asc" }, select: { id: true, physicalPageIndex: true } }, structureNodes: { orderBy: { ordinal: "asc" } }, blocks: { orderBy: { ordinal: "asc" }, take: 40 } } } } },
      currentIntelligence: { include: { analysisRun: { include: { memoryItems: { include: { evidence: { include: { sourceBlock: true } } }, orderBy: { ordinal: "asc" }, take: 80 }, artifacts: { where: { scope: "BOOK" }, take: 1 } } } } },
    },
  });
  if (!record) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  // Preview only the owner's current published extraction, independently of AI
  // memories. Never read unpublished candidates or another document's pages.
  const extraction = record.currentExtraction?.extraction;
  const pages = extraction?.status === "SUCCEEDED" ? extraction.pages : [];
  const pageNumber = Math.min(Math.max(1, Number.isSafeInteger(requestedTextPage) ? requestedTextPage : 1), Math.max(1, pages.length));
  const page = pages[pageNumber - 1];
  const blocks = page ? await prisma.sourceBlock.findMany({ where: { extractionId: extraction!.id, sourcePageId: page.id }, orderBy: { ordinal: "asc" }, take: 41, select: { id: true, ordinal: true, text: true } }) : [];
  const textPreview = page ? { pageNumber, pageCount: pages.length, physicalPageNumber: page.physicalPageIndex === null ? null : page.physicalPageIndex + 1, truncated: blocks.length > 40 || blocks.some(block => block.text.length > 4000), blocks: blocks.slice(0, 40).map(block => ({ ...block, text: block.text.slice(0, 4000) })) } : null;
  return { ...record, textPreview };
}
