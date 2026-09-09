import { NextResponse } from "next/server";
import { sourceDetail } from "@/lib/product";
import { deriveProcessingState } from "@/lib/processing-state";
import { processingWorkerAvailability } from "@/lib/worker-heartbeat";

export async function GET(_: Request, { params }: { params: Promise<{ sourceDocumentId: string }> }) {
  try {
    const item = await sourceDetail((await params).sourceDocumentId), workerAvailability = await processingWorkerAvailability();
    const ingestion = item.ingestionRuns[0], analysis = item.analysisRuns[0];
    const errorCode = ingestion?.errorCode ?? analysis?.errorCode ?? null;
    const safeFailureCode = errorCode && /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : null;
    return NextResponse.json({ processingState: deriveProcessingState({ ingestion, analysis, hasIntelligence: Boolean(item.currentIntelligence), workerAvailability, staleAfterMs: Number(process.env.SOURCE_PARSE_TIMEOUT_MS ?? 120_000) }), ingestionStatus: ingestion?.status ?? null, analysisStatus: analysis?.status ?? null, queuedAt: ingestion?.createdAt?.toISOString() ?? null, startedAt: ingestion?.startedAt?.toISOString() ?? null, updatedAt: ingestion?.startedAt?.toISOString() ?? ingestion?.createdAt?.toISOString() ?? null, workerAvailability, recoverable: !item.currentIntelligence && (!ingestion || ["FAILED", "REJECTED", "OCR_REQUIRED", "PASSWORD_REQUIRED"].includes(ingestion.status)), safeFailureCode });
  } catch { return NextResponse.json({ error: "SOURCE_DOCUMENT_ACCESS_DENIED" }, { status: 403 }); }
}
