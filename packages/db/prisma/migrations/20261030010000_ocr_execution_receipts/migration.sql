-- Additive: historical checkpoints retain NULL (unknown), never invented provenance.
ALTER TABLE "OcrPageAttempt"
  ADD COLUMN "proposedTier" TEXT, ADD COLUMN "admittedTier" TEXT,
  ADD COLUMN "actualTier" TEXT, ADD COLUMN "manifestDigest" TEXT,
  ADD COLUMN "executionStatus" TEXT, ADD COLUMN "fallbackReason" TEXT,
  ADD COLUMN "sourceIdentity" JSONB, ADD COLUMN "claimIdentity" JSONB,
  ADD COLUMN "qualityStatus" TEXT;
CREATE TABLE "OcrPageExecution" (
  "id" TEXT NOT NULL PRIMARY KEY, "pageAttemptId" TEXT NOT NULL,
  "pageClaimToken" TEXT NOT NULL, "runExecutionToken" TEXT NOT NULL,
  "hostClaimToken" TEXT, "serverIdentity" JSONB,
  "proposedTier" TEXT, "admittedTier" TEXT, "actualTier" TEXT,
  "modelRevision" TEXT, "manifestDigest" TEXT, "executionStatus" TEXT NOT NULL,
  "fallbackReason" TEXT, "errorCode" TEXT, "resultTextSha256" TEXT,
  "sourceIdentity" JSONB NOT NULL, "qualityDecision" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OcrPageExecution_pageAttemptId_fkey" FOREIGN KEY ("pageAttemptId") REFERENCES "OcrPageAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OcrPageExecution_status_check" CHECK ("executionStatus" IN ('SUCCEEDED','FAILED')),
  CONSTRAINT "OcrPageExecution_success_requires_actual" CHECK ("executionStatus" <> 'SUCCEEDED' OR ("actualTier" IS NOT NULL AND "resultTextSha256" IS NOT NULL)),
  CONSTRAINT "OcrPageExecution_standard_requires_model" CHECK ("actualTier" IS DISTINCT FROM 'standard' OR ("modelRevision" IS NOT NULL AND "manifestDigest" IS NOT NULL))
);
CREATE UNIQUE INDEX "OcrPageExecution_pageClaimToken_key" ON "OcrPageExecution"("pageClaimToken");
CREATE INDEX "OcrPageExecution_pageAttemptId_createdAt_idx" ON "OcrPageExecution"("pageAttemptId","createdAt");
