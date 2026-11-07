CREATE TABLE "BookIntelligenceRevision" (
    "id" TEXT PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "chunkSetId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "originalHash" TEXT NOT NULL,
    "revisionHash" TEXT NOT NULL,
    "patch" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookRevision_run_lineage_fkey" FOREIGN KEY ("analysisRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId")
      REFERENCES "BookAnalysisRun" ("id", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BookIntelligenceRevision_analysisRunId_revisionHash_key" ON "BookIntelligenceRevision"("analysisRunId", "revisionHash");
CREATE INDEX "BookRevision_workspace_document_created_idx" ON "BookIntelligenceRevision"("workspaceId", "sourceDocumentId", "createdAt");

CREATE TABLE "BookIntelligenceRevisionReview" (
    "id" TEXT PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "revisionHash" TEXT NOT NULL,
    "reviewHash" TEXT NOT NULL,
    "decision" JSONB NOT NULL,
    "vectorReady" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookIntelligenceRevisionReview_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "BookIntelligenceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BookIntelligenceRevisionReview_revisionId_reviewHash_key" ON "BookIntelligenceRevisionReview"("revisionId", "reviewHash");
