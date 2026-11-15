-- A durable per-operation cursor and conservative remote-outcome evidence.
-- Does not authorize provider switching or paid retries. Old jobs have no rows.
CREATE TABLE "BookFailoverCheckpoint" (
  "workspaceId" TEXT NOT NULL,
  "analysisRunId" TEXT NOT NULL,
  "routeSlot" TEXT NOT NULL,
  "operationHash" TEXT NOT NULL,
  "planHash" TEXT NOT NULL,
  "candidateIndex" INTEGER NOT NULL DEFAULT 0,
  "switchesUsed" INTEGER NOT NULL DEFAULT 0,
  "state" TEXT NOT NULL DEFAULT 'HOLD',
  "holdReason" TEXT NOT NULL DEFAULT 'NOT_ENABLED',
  "latestInvocationId" TEXT,
  "latestAttemptId" TEXT,
  "lastFailureCode" TEXT,
  "settledOutcome" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "observedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookFailoverCheckpoint_pkey" PRIMARY KEY ("analysisRunId", "routeSlot", "operationHash"),
  CONSTRAINT "BookFailoverCheckpoint_invariants" CHECK (
    "routeSlot" IN ('BOOK_CHUNK_ANALYSIS','BOOK_REDUCTION_ANALYSIS','BOOK_SYNTHESIS')
    AND "operationHash" ~ '^[a-f0-9]{64}$'
    AND "planHash" ~ '^[a-f0-9]{64}$'
    AND "candidateIndex" BETWEEN 0 AND 2
    AND "switchesUsed" BETWEEN 0 AND 2
    AND "candidateIndex" = "switchesUsed"
    AND "revision" >= 1
    AND "state" IN ('HOLD','SWITCH_RESERVED','RECONCILIATION_REQUIRED')
    AND "settledOutcome" IN ('UNKNOWN','NOT_SENT','PROVIDER_CONFIRMED_UNBILLED','PAID_AND_RECONCILED')
  )
);
CREATE INDEX "BookFailoverCheckpoint_workspaceId_analysisRunId_updatedAt_idx"
  ON "BookFailoverCheckpoint" ("workspaceId", "analysisRunId", "updatedAt");
ALTER TABLE "BookFailoverCheckpoint" ADD CONSTRAINT "BookFailoverCheckpoint_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookFailoverCheckpoint" ADD CONSTRAINT "BookFailoverCheckpoint_analysisRunId_workspaceId_fkey"
  FOREIGN KEY ("analysisRunId","workspaceId") REFERENCES "BookAnalysisRun"("id","workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
