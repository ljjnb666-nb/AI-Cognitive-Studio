-- Durable ingestion-to-book-analysis bootstrap intent.  It intentionally owns
-- provider-waiting semantics independently from the finite-retry outbox.
CREATE TYPE "BookAnalysisBootstrapStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_FOR_PROVIDER', 'SUCCEEDED', 'FAILED_TERMINAL');

CREATE TABLE "BookAnalysisBootstrap" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "ingestionRunId" TEXT NOT NULL,
  "extractionId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "status" "BookAnalysisBootstrapStatus" NOT NULL DEFAULT 'PENDING',
  "analysisRunId" TEXT,
  "errorCode" TEXT,
  "executionClaimToken" TEXT,
  "executionClaimedAt" TIMESTAMP(3),
  "executionLeaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "BookAnalysisBootstrap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookBootstrap_ingestion_key" ON "BookAnalysisBootstrap"("ingestionRunId");
CREATE UNIQUE INDEX "BookBootstrap_lineage_key" ON "BookAnalysisBootstrap"("workspaceId", "sourceDocumentId", "ingestionRunId", "extractionId");
CREATE INDEX "BookBootstrap_status_lease_idx" ON "BookAnalysisBootstrap"("workspaceId", "status", "executionLeaseUntil");
CREATE INDEX "BookBootstrap_analysis_idx" ON "BookAnalysisBootstrap"("analysisRunId", "workspaceId");

ALTER TABLE "BookAnalysisBootstrap" ADD CONSTRAINT "BookAnalysisBootstrap_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookAnalysisBootstrap" ADD CONSTRAINT "BookBootstrap_source_fk" FOREIGN KEY ("sourceDocumentId", "workspaceId") REFERENCES "SourceDocument"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookAnalysisBootstrap" ADD CONSTRAINT "BookBootstrap_ingestion_fk" FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId") REFERENCES "IngestionRun"("id", "sourceDocumentId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookAnalysisBootstrap" ADD CONSTRAINT "BookBootstrap_extraction_fk" FOREIGN KEY ("extractionId", "sourceDocumentId", "workspaceId") REFERENCES "DocumentExtraction"("id", "sourceDocumentId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookAnalysisBootstrap" ADD CONSTRAINT "BookBootstrap_member_fk" FOREIGN KEY ("workspaceId", "requestedByUserId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookAnalysisBootstrap" ADD CONSTRAINT "BookBootstrap_run_fk" FOREIGN KEY ("analysisRunId", "workspaceId") REFERENCES "BookAnalysisRun"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
