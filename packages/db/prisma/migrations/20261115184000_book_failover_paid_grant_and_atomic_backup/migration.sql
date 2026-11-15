-- Deliberately empty by default: preference/requestedEnabled is not an
-- authorization to incur a new paid call. Grants require a separate owner act.
CREATE TABLE "BookFailoverPaidGrant" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "analysisRunId" TEXT NOT NULL,
  "routeSlot" TEXT NOT NULL,
  "operationHash" TEXT NOT NULL,
  "planHash" TEXT NOT NULL,
  "nextCandidateIndex" INTEGER NOT NULL,
  "authorizedByUserId" TEXT NOT NULL,
  "maxAdditionalUnits" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookFailoverPaidGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookFailoverPaidGrant_bounds" CHECK (
    "nextCandidateIndex" BETWEEN 1 AND 2
    AND "maxAdditionalUnits" BETWEEN 1 AND 1000000
    AND "operationHash" ~ '^[a-f0-9]{64}$'
    AND "planHash" ~ '^[a-f0-9]{64}$'
    AND "routeSlot" IN ('BOOK_CHUNK_ANALYSIS','BOOK_REDUCTION_ANALYSIS','BOOK_SYNTHESIS')
    AND ("usedAt" IS NULL OR "usedAt" >= "createdAt")
  )
);
CREATE UNIQUE INDEX "BookFailoverPaidGrant_analysisRunId_routeSlot_operationHash_nextCandidateIndex_key"
  ON "BookFailoverPaidGrant" ("analysisRunId","routeSlot","operationHash","nextCandidateIndex");
CREATE UNIQUE INDEX "BookFailoverPaidGrant_id_workspaceId_key"
  ON "BookFailoverPaidGrant" ("id","workspaceId");
CREATE INDEX "BookFailoverPaidGrant_workspaceId_expiresAt_idx"
  ON "BookFailoverPaidGrant" ("workspaceId","expiresAt");
ALTER TABLE "BookFailoverPaidGrant" ADD CONSTRAINT "BookFailoverPaidGrant_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookFailoverPaidGrant" ADD CONSTRAINT "BookFailoverPaidGrant_analysisRunId_workspaceId_fkey"
  FOREIGN KEY ("analysisRunId","workspaceId") REFERENCES "BookAnalysisRun"("id","workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookFailoverCheckpoint"
  ADD COLUMN "backupSendKey" TEXT,
  ADD COLUMN "backupSendHash" TEXT,
  ADD COLUMN "backupReservedAt" TIMESTAMP(3),
  ADD COLUMN "paidGrantId" TEXT;
CREATE UNIQUE INDEX "BookFailoverCheckpoint_workspaceId_backupSendKey_key"
  ON "BookFailoverCheckpoint" ("workspaceId","backupSendKey");
ALTER TABLE "BookFailoverCheckpoint"
  ADD CONSTRAINT "BookFailoverCheckpoint_backup_send_integrity" CHECK (
    ("backupSendKey" IS NULL AND "backupSendHash" IS NULL
      AND "backupReservedAt" IS NULL AND "paidGrantId" IS NULL)
    OR
    ("backupSendKey" IS NOT NULL AND length("backupSendKey") BETWEEN 1 AND 2048
      AND "backupSendHash" ~ '^[a-f0-9]{64}$'
      AND "backupReservedAt" IS NOT NULL AND "paidGrantId" IS NOT NULL
      AND "state" = 'SWITCH_RESERVED' AND "candidateIndex" >= 1)
  );
ALTER TABLE "BookFailoverCheckpoint"
  ADD CONSTRAINT "BookFailoverCheckpoint_paidGrantId_fkey"
  FOREIGN KEY ("paidGrantId","workspaceId") REFERENCES "BookFailoverPaidGrant"("id","workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
