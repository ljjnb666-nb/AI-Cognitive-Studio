ALTER TABLE "AnalysisArtifact" ADD COLUMN "structureNodeId" TEXT;
ALTER TABLE "BookMemoryItem" ADD COLUMN "sourceArtifactId" TEXT;
ALTER TABLE "BookMemoryItem" ADD COLUMN "memoryKey" TEXT;
ALTER TABLE "DocumentChunkEmbedding" ADD COLUMN "embeddingIdentityHash" TEXT;
ALTER TABLE "BookMemoryEmbedding" ADD COLUMN "embeddingIdentityHash" TEXT;

CREATE TABLE "AnalysisReductionResult" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "analysisRunId" TEXT NOT NULL,
  "stage" "AnalysisScope" NOT NULL, "parentKey" TEXT NOT NULL, "level" INTEGER NOT NULL,
  "batchOrdinal" INTEGER NOT NULL, "inputHash" TEXT NOT NULL, "summary" TEXT NOT NULL,
  "structuredOutput" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalysisReductionResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalysisReductionResult_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "BookAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AnalysisArtifact_chunk_identity" ON "AnalysisArtifact" ("analysisRunId", "chunkId") WHERE "scope" = 'CHUNK' AND "chunkId" IS NOT NULL;
CREATE UNIQUE INDEX "AnalysisArtifact_section_chapter_identity" ON "AnalysisArtifact" ("analysisRunId", "structureNodeId", "scope") WHERE "scope" IN ('SECTION', 'CHAPTER') AND "structureNodeId" IS NOT NULL;
CREATE UNIQUE INDEX "AnalysisArtifact_book_identity" ON "AnalysisArtifact" ("analysisRunId") WHERE "scope" = 'BOOK';
CREATE UNIQUE INDEX "BookMemoryItem_memoryKey_key" ON "BookMemoryItem" ("memoryKey") WHERE "memoryKey" IS NOT NULL;
CREATE UNIQUE INDEX "BookMemoryEvidence_identity" ON "BookMemoryEvidence" ("memoryItemId", "sourceBlockId", "startOffset", "endOffset", COALESCE("quoteHash", ''));
CREATE UNIQUE INDEX "DocumentChunkEmbedding_identity" ON "DocumentChunkEmbedding" ("chunkId", "embeddingIdentityHash") WHERE "embeddingIdentityHash" IS NOT NULL;
CREATE UNIQUE INDEX "BookMemoryEmbedding_identity" ON "BookMemoryEmbedding" ("memoryItemId", "embeddingIdentityHash") WHERE "embeddingIdentityHash" IS NOT NULL;
CREATE UNIQUE INDEX "AnalysisReductionResult_identity" ON "AnalysisReductionResult" ("analysisRunId", "stage", "parentKey", "level", "batchOrdinal", "inputHash");
