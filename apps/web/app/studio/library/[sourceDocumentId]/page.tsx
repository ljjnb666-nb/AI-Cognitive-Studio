import { notFound } from "next/navigation";
import { sourceDetail } from "@/lib/product";
import { BookDetailView } from "@/components/book-detail-view";
import { deriveProcessingState } from "@/lib/processing-state";
import { processingWorkerAvailability } from "@/lib/worker-heartbeat";

export default async function SourcePage({ params }: { params: Promise<{ sourceDocumentId: string }> }) {
  const { sourceDocumentId } = await params;
  let item: Awaited<ReturnType<typeof sourceDetail>>;

  try {
    item = await sourceDetail(sourceDocumentId);
  } catch (error) {
    if (error instanceof Error && error.message === "SOURCE_DOCUMENT_ACCESS_DENIED") notFound();
    throw error;
  }

  const memories = item.currentIntelligence?.analysisRun.memoryItems ?? [];
  const structureNodes = item.currentExtraction?.extraction.structureNodes ?? [];
  const ingestionStatus = item.ingestionRuns[0]?.status;
  const analysisStatus = item.analysisRuns[0]?.status;
  const errorCode = item.ingestionRuns[0]?.errorCode ?? item.analysisRuns[0]?.errorCode;
  const workerAvailability = await processingWorkerAvailability();
  const processingState = deriveProcessingState({ ingestion: item.ingestionRuns[0], analysis: item.analysisRuns[0], hasIntelligence: Boolean(item.currentIntelligence), workerAvailability, staleAfterMs: Number(process.env.SOURCE_PARSE_TIMEOUT_MS ?? 120_000) });

  return (
    <BookDetailView
      item={{
        id: item.id,
        displayName: item.source.displayName,
        mediaType: item.mediaType,
        version: item.version,
        hasIntelligence: Boolean(item.currentIntelligence),
        ingestionStatus,
        analysisStatus,
        errorCode,
        processingState,
        workerAvailability,
        processingSince: (item.analysisRuns[0]?.startedAt ?? item.analysisRuns[0]?.createdAt ?? item.ingestionRuns[0]?.startedAt ?? item.ingestionRuns[0]?.createdAt)?.toISOString() ?? null,
      }}
      memories={memories as any}
      structureNodes={structureNodes as any}
    />
  );
}
