import { CancelJobButton } from "@/components/cancel-job-button";
import { notFound } from "next/navigation";
import { sourceDetail } from "@/lib/product";
import { projectBookDisplay } from "@/lib/book-display";
import { BookDetailView } from "@/components/book-detail-view";
import { sourceProcessingSnapshot } from "@/lib/processing-state";
import { processingWorkerAvailability } from "@/lib/worker-heartbeat";

export default async function SourcePage({ params, searchParams }: { params: Promise<{ sourceDocumentId: string }>; searchParams:Promise<{textPage?:string}> }) {
  const { sourceDocumentId } = await params;
  let item: Awaited<ReturnType<typeof sourceDetail>>;

  try {
    const query = await searchParams;
    const page = query.textPage && /^\d{1,9}$/.test(query.textPage) ? Number(query.textPage) : 1;
    item = await sourceDetail(sourceDocumentId, undefined, page);
  } catch (error) {
    if (error instanceof Error && error.message === "SOURCE_DOCUMENT_ACCESS_DENIED") notFound();
    throw error;
  }

  const memories = item.currentIntelligence?.analysisRun.memoryItems ?? [];
  const structureNodes = item.currentExtraction?.extraction.structureNodes ?? [];
  const ingestionStatus = item.ingestionRuns[0]?.status;
  const analysisStatus = item.analysisRuns[0]?.status;
  const bootstrap = item.bookAnalysisBootstraps[0];
  const workerAvailability = await processingWorkerAvailability();
  const snapshot = sourceProcessingSnapshot({ ingestion: item.ingestionRuns[0], analysis: item.analysisRuns[0], bootstrap, hasIntelligence: Boolean(item.currentIntelligence), workerAvailability, staleAfterMs: Number(process.env.SOURCE_PARSE_TIMEOUT_MS ?? 120_000) });
  const { processing, errorCode, processingSince } = snapshot;

  return (
    <div className="book-detail-page">
    <div className="actions">
    <a className="btn btn-secondary" href={`/api/studio/sources/${encodeURIComponent(item.id)}/download`} download>下载原始文件</a>
    {item.analysisRuns[0] && ["QUEUED", "RUNNING"].includes(item.analysisRuns[0].status) && <CancelJobButton jobId={item.analysisRuns[0].jobId} />}
    </div>
    <BookDetailView
      textPreview={item.textPreview}
      item={{
        id: item.id,
        displayName: item.source.displayName,
        ...projectBookDisplay({
          fileName: item.source.displayName,
          workTitle: item.source.edition?.work.title,
          version: item.version,
          isLatestVersion: item.source.documents[0]?.id === item.id,
        }),
        mediaType: item.mediaType,
        version: item.version,
        hasIntelligence: Boolean(item.currentIntelligence),
        currentExtractionId: item.currentExtraction?.extractionId ?? null,
        extractionSummary: item.currentExtraction?.extraction.status === "SUCCEEDED" ? {pages:item.currentExtraction.extraction._count.pages,blocks:item.currentExtraction.extraction._count.blocks,characters:item.currentExtraction.extraction.characterCount}:null,
        ingestionStatus,
        analysisStatus,
        bootstrapStatus: bootstrap?.status,
        errorCode,
        failureReason: processing.failureReason,
        processingState: processing.state,
        processingStage: processing.stage,
        recoveryAction: processing.recoveryAction,
        stageAvailability: processing.stageAvailability,
        workerAvailability,
        processingSince,
      }}
      memories={memories as any}
      structureNodes={structureNodes as any}
    />
    </div>
  );
}
