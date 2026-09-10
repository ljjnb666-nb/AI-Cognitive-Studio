import { materializeChunkSet, recoverBookAnalysisForUser, requestBookAnalysisForUser } from "@ai-cognitive/book-intelligence";
import { NextResponse } from "next/server";
import { createIngestionService } from "@ai-cognitive/ingestion";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { resolveWebIdentity } from "@/lib/identity";
import { sourceDetail } from "@/lib/product";
import { deriveProcessingStatus } from "@/lib/processing-state";
import { resolveBookProductExecution } from "@/lib/provider-product";
import { processingWorkerAvailability } from "@/lib/worker-heartbeat";

async function requestAnalysis(identity: Awaited<ReturnType<typeof resolveWebIdentity>>, sourceDocumentId: string) {
  const provider = await resolveBookProductExecution(identity.workspaceId);
  const chunkSet = await materializeChunkSet({ workspaceId: identity.workspaceId, sourceDocumentId });
  return requestBookAnalysisForUser(identity, { sourceDocumentId, chunkSetId: chunkSet.id, pipelineVersion: process.env.BOOK_ANALYSIS_PIPELINE_VERSION?.trim() || "product-v1", promptVersion: process.env.BOOK_ANALYSIS_PROMPT_VERSION?.trim() || "product-v1", provider: provider.provider, model: provider.model, modelVersion: provider.modelVersion, outboxTopic: process.env.PHASE9_BOOK_TOPIC?.trim() || undefined });
}

export async function POST(_: Request, { params }: { params: Promise<{ sourceDocumentId: string }> }) {
  try {
    const sourceDocumentId = (await params).sourceDocumentId, identity = await resolveWebIdentity();
    const [item, workerAvailability] = await Promise.all([sourceDetail(sourceDocumentId, identity), processingWorkerAvailability()]);
    const status = deriveProcessingStatus({ ingestion: item.ingestionRuns[0], analysis: item.analysisRuns[0], hasIntelligence: Boolean(item.currentIntelligence), workerAvailability, staleAfterMs: Number(process.env.SOURCE_PARSE_TIMEOUT_MS ?? 120_000) });
    if (status.recoveryAction === "RETRY_INGESTION") {
      const environment = readEnvironment();
      const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
      await createIngestionService(storage).recoverIngestionForUser(identity, sourceDocumentId, process.env.PHASE9_SOURCE_TOPIC ? { outboxTopic: process.env.PHASE9_SOURCE_TOPIC } : undefined);
    } else if (status.recoveryAction === "RETRY_ANALYSIS") {
      if (status.state === "WAITING_FOR_ANALYSIS") await requestAnalysis(identity, sourceDocumentId);
      else await recoverBookAnalysisForUser(identity, sourceDocumentId, { outboxTopic: process.env.PHASE9_BOOK_TOPIC?.trim() || undefined });
    } else if (status.recoveryAction === "REPAIR_CURRENT_INTELLIGENCE") {
      // A completed historical extraction is never promoted. Start analysis
      // only for the durable current extraction, without replaying ingestion.
      if (item.analysisRuns[0]?.extractionId !== item.currentExtraction?.extractionId) await requestAnalysis(identity, sourceDocumentId);
      else await recoverBookAnalysisForUser(identity, sourceDocumentId);
    }
    return NextResponse.json({ result: "RECOVERY_ACCEPTED", recoveryAction: status.recoveryAction });
  } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "PROCESSING_RECOVERY_FAILED"; return NextResponse.json({ error: code.includes("ACCESS_DENIED") ? code : "PROCESSING_RECOVERY_FAILED" }, { status: code.includes("ACCESS_DENIED") ? 403 : 400 }); }
}
