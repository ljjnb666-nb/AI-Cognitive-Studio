import { materializeChunkSet, requestBookAnalysisForUser } from "@ai-cognitive/book-intelligence";
import { prisma } from "@ai-cognitive/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";

const schema = z.object({ sourceDocumentId: z.string().cuid() });

function failure(error: unknown) {
  const code = error instanceof Error ? error.message.split(":")[0] : "BOOK_INTELLIGENCE_REQUEST_FAILED";
  const status = code.includes("ACCESS_DENIED") || code === "WEB_IDENTITY_REQUIRED" ? 403 : code === "INGESTION_NOT_SUCCEEDED" ? 409 : 400;
  return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request) {
  try {
    const { sourceDocumentId } = schema.parse(await request.json());
    const identity = await resolveWebIdentity();
    const document = await prisma.sourceDocument.findFirstOrThrow({
      where: { id: sourceDocumentId, workspaceId: identity.workspaceId },
      include: { ingestionRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } } },
    });
    if (document.ingestionRuns[0]?.status !== "SUCCEEDED") throw new Error("INGESTION_NOT_SUCCEEDED");
    const provider = process.env.BOOK_ANALYSIS_PROVIDER?.trim();
    const model = process.env.BOOK_ANALYSIS_MODEL?.trim();
    if (!provider || !model) throw new Error("BOOK_ANALYSIS_PROVIDER_NOT_CONFIGURED");
    const chunkSet = await materializeChunkSet({ workspaceId: identity.workspaceId, sourceDocumentId: document.id });
    const requested = await requestBookAnalysisForUser({ workspaceId: identity.workspaceId, userId: identity.userId }, {
      sourceDocumentId: document.id,
      chunkSetId: chunkSet.id,
      pipelineVersion: process.env.BOOK_ANALYSIS_PIPELINE_VERSION?.trim() || "product-v1",
      promptVersion: process.env.BOOK_ANALYSIS_PROMPT_VERSION?.trim() || "product-v1",
      provider,
      model,
      modelVersion: process.env.BOOK_ANALYSIS_MODEL_VERSION?.trim(),
    });
    return NextResponse.json({ analysisRunId: requested.run.id, status: requested.run.status, stage: requested.run.analysisStage });
  } catch (error) { return failure(error); }
}
