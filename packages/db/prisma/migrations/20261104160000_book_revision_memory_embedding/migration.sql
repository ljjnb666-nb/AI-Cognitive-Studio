CREATE TABLE "BookRevisionMemoryEmbedding" (
  "revisionId" TEXT NOT NULL,
  "memoryItemId" TEXT NOT NULL,
  "analysisRunId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "extractionId" TEXT NOT NULL,
  "invocationId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "embeddingIdentityHash" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL CHECK ("dimensions" > 0),
  "vector" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("revisionId", "memoryItemId"),
  CONSTRAINT "BookRevisionEmbedding_revision_fkey" FOREIGN KEY ("revisionId", "analysisRunId") REFERENCES "BookIntelligenceRevision" ("id", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookRevisionEmbedding_memory_fkey" FOREIGN KEY ("memoryItemId", "analysisRunId", "workspaceId", "extractionId") REFERENCES "BookMemoryItem" ("id", "analysisRunId", "workspaceId", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookRevisionEmbedding_receipt_fkey" FOREIGN KEY ("invocationId", "workspaceId") REFERENCES "ProviderEmbeddingResult" ("invocationId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BookRevisionEmbedding_receipt_key" ON "BookRevisionMemoryEmbedding" ("invocationId", "workspaceId");
CREATE INDEX "BookRevisionEmbedding_memory_idx" ON "BookRevisionMemoryEmbedding" ("memoryItemId", "analysisRunId", "workspaceId", "extractionId");
