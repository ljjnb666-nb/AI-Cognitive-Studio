-- BOOK-INGESTION-04B-1 durable OCR execution foundation.
-- Strictly additive: nullable claim/routing columns on IngestionRun, plus new
-- OCR durability tables. Historical rows keep NULL; no backfill.

-- Execute-claim fence + routing durability on IngestionRun.
ALTER TABLE "IngestionRun" ADD COLUMN "executionClaimToken" TEXT;
ALTER TABLE "IngestionRun" ADD COLUMN "executionClaimedAt" TIMESTAMP(3);
ALTER TABLE "IngestionRun" ADD COLUMN "executionLeaseUntil" TIMESTAMP(3);
ALTER TABLE "IngestionRun" ADD COLUMN "routingGeneration" INTEGER;
ALTER TABLE "IngestionRun" ADD COLUMN "routingPlan" JSONB;
ALTER TABLE "IngestionRun" ADD COLUMN "routingOutcome" JSONB;
CREATE INDEX "IngestionRun_executionLeaseUntil_idx" ON "IngestionRun"("executionLeaseUntil");

-- CreateEnum
CREATE TYPE "OcrPageAttemptStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "OcrServerInstanceStatus" AS ENUM ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ORPHANED');

-- Current per-host OCR capacity authority (fenced lease; no server identity here).
CREATE TABLE "OcrHostLease" (
    "hostId" TEXT NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "hostMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OcrHostLease_pkey" PRIMARY KEY ("hostId")
);
CREATE INDEX "OcrHostLease_leaseUntil_idx" ON "OcrHostLease"("leaseUntil");

-- Authoritative page checkpoint: one row per (run, physical page, generation).
CREATE TABLE "OcrPageAttempt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "ingestionRunId" TEXT NOT NULL,
    "physicalPageIndex" INTEGER NOT NULL,
    "routingGeneration" INTEGER NOT NULL,
    "status" "OcrPageAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "parserName" TEXT,
    "parserVersion" TEXT,
    "parserMode" TEXT,
    "modelRevision" TEXT,
    "errorCode" TEXT,
    "durationMs" INTEGER,
    "authoritativeArtifactKey" TEXT,
    "textSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OcrPageAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OcrPageAttempt_ingestionRunId_physicalPageIndex_routingGene_key" ON "OcrPageAttempt"("ingestionRunId", "physicalPageIndex", "routingGeneration");
CREATE INDEX "OcrPageAttempt_ingestionRunId_routingGeneration_idx" ON "OcrPageAttempt"("ingestionRunId", "routingGeneration");
CREATE INDEX "OcrPageAttempt_status_nextAttemptAt_idx" ON "OcrPageAttempt"("status", "nextAttemptAt");
CREATE INDEX "OcrPageAttempt_workspaceId_idx" ON "OcrPageAttempt"("workspaceId");

-- Durable detached-server instance identity/history; one row per hostClaimToken.
CREATE TABLE "OcrServerInstance" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "ingestionRunId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "hostClaimToken" TEXT NOT NULL,
    "runExecutionToken" TEXT NOT NULL,
    "mineruHome" TEXT NOT NULL,
    "pid" INTEGER,
    "serverId" TEXT,
    "transports" JSONB,
    "status" "OcrServerInstanceStatus" NOT NULL DEFAULT 'STARTING',
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OcrServerInstance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OcrServerInstance_hostClaimToken_key" ON "OcrServerInstance"("hostClaimToken");
CREATE INDEX "OcrServerInstance_hostId_status_idx" ON "OcrServerInstance"("hostId", "status");
CREATE INDEX "OcrServerInstance_workspaceId_idx" ON "OcrServerInstance"("workspaceId");

-- Composite tenant-lineage foreign keys (fail closed across workspaces).
-- IngestionRun @@unique([id, sourceDocumentId, workspaceId]) backs both FKs.
ALTER TABLE "OcrPageAttempt" ADD CONSTRAINT "OcrPageAttempt_ingestionRunId_sourceDocumentId_workspaceId_fkey" FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId") REFERENCES "IngestionRun"("id", "sourceDocumentId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OcrServerInstance" ADD CONSTRAINT "OcrServerInstance_ingestionRunId_sourceDocumentId_workspac_fkey" FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId") REFERENCES "IngestionRun"("id", "sourceDocumentId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
