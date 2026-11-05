CREATE UNIQUE INDEX "BookIntelligenceRevision_id_analysisRunId_key"
ON "BookIntelligenceRevision"("id", "analysisRunId");

CREATE TABLE "BookRevisionPublication" (
  "id" TEXT PRIMARY KEY,
  "analysisRunId" TEXT NOT NULL REFERENCES "BookAnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "revisionId" TEXT,
  "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reviewHash" TEXT,
  "action" TEXT NOT NULL CHECK ("action" IN ('PUBLISH', 'ROLLBACK')),
  "previousId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookRevisionPublication_revision_fkey" FOREIGN KEY ("revisionId", "analysisRunId")
    REFERENCES "BookIntelligenceRevision"("id", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BookRevisionPublication_analysisRunId_sequence_key"
ON "BookRevisionPublication"("analysisRunId", "sequence");
CREATE UNIQUE INDEX "BookRevisionPublication_analysisRunId_requestId_key"
ON "BookRevisionPublication"("analysisRunId", "requestId");
