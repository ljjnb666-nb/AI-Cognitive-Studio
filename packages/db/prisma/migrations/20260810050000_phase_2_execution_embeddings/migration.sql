-- Additive Phase 2 execution linkage and durable embedding storage.
ALTER TABLE "BookAnalysisRun" ADD COLUMN "jobId" TEXT;
INSERT INTO "Job" ("id", "workspaceId", "type", "status", "progress", "attemptCount", "payload", "idempotencyKey", "createdAt", "updatedAt")
SELECT 'phase2-' || "id", "workspaceId", 'book.analysis', 'QUEUED'::"JobStatus", 0, 0,
  jsonb_build_object('sourceDocumentId', "sourceDocumentId", 'chunkSetId', "chunkSetId"),
  'phase2-backfill:' || "id", NOW(), NOW()
FROM "BookAnalysisRun";
UPDATE "BookAnalysisRun" SET "jobId" = 'phase2-' || "id" WHERE "jobId" IS NULL;
ALTER TABLE "BookAnalysisRun" ALTER COLUMN "jobId" SET NOT NULL;
ALTER TABLE "BookAnalysisRun" ADD CONSTRAINT "BookAnalysisRun_jobId_key" UNIQUE ("jobId");
ALTER TABLE "BookAnalysisRun" ADD CONSTRAINT "BookAnalysisRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT;

ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_id_workspaceId_extractionId_key" UNIQUE ("id", "workspaceId", "extractionId");
CREATE TABLE "DocumentChunkEmbedding" (
  "id" TEXT PRIMARY KEY, "chunkId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "extractionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL, "model" TEXT NOT NULL, "modelVersion" TEXT, "embeddingVersion" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL, "vector" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("chunkId", "embeddingVersion"),
  FOREIGN KEY("chunkId", "workspaceId", "extractionId") REFERENCES "DocumentChunk"("id", "workspaceId", "extractionId") ON DELETE CASCADE
);
CREATE INDEX "DocumentChunkEmbedding_workspaceId_extractionId_embeddingVersion_idx" ON "DocumentChunkEmbedding"("workspaceId", "extractionId", "embeddingVersion");
CREATE TABLE "BookMemoryEmbedding" (
  "id" TEXT PRIMARY KEY, "memoryItemId" TEXT NOT NULL, "analysisRunId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "extractionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL, "model" TEXT NOT NULL, "modelVersion" TEXT, "embeddingVersion" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL, "vector" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("memoryItemId", "embeddingVersion"),
  FOREIGN KEY("memoryItemId", "analysisRunId", "workspaceId", "extractionId") REFERENCES "BookMemoryItem"("id", "analysisRunId", "workspaceId", "extractionId") ON DELETE CASCADE
);
CREATE INDEX "BookMemoryEmbedding_workspaceId_extractionId_embeddingVersion_idx" ON "BookMemoryEmbedding"("workspaceId", "extractionId", "embeddingVersion");
