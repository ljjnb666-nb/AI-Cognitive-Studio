-- Independent SECOND model-call consent is never inherited from first graph generation.
-- A unique per-ingestion/run-generation/page row prevents refreshing or racing
-- browser requests from creating multiple chargeable admissions.
-- Initial status is NOT dispatched; no Worker is registered by this migration.
CREATE TABLE "PdfGraphSecondReviewRequest" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "ingestionRunId" TEXT NOT NULL,
  "routingGeneration" INTEGER NOT NULL,
  "physicalPageIndex" INTEGER NOT NULL,
  "sourcePdfSha256" TEXT NOT NULL,
  "sourcePngSha256" TEXT NOT NULL,
  "candidateSha256" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AUTHORIZED_NOT_DISPATCHED',
  "consentRecordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "failureCode" TEXT,
  "invocationId" TEXT,
  "snapshotId" TEXT,
  "modelDecision" TEXT,
  "modelAxes" JSONB,
  CONSTRAINT "PdfGraphSecondReviewRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PdfGraphSecondReviewRequest_validity" CHECK (
    "routingGeneration" >= 1 AND "physicalPageIndex" BETWEEN 0 AND 1999 AND
    "sourcePdfSha256" ~ '^[0-9a-f]{64}$' AND
    "sourcePngSha256" ~ '^[0-9a-f]{64}$' AND
    "candidateSha256" ~ '^[0-9a-f]{64}$' AND
    "status" IN ('AUTHORIZED_NOT_DISPATCHED','RUNNING','SUCCEEDED','REVIEW_REQUIRED','REJECTED','FAILED','EXPIRED') AND
    ("modelDecision" IS NULL OR "modelDecision" IN ('PASSED','REJECTED','REVIEW_REQUIRED')) AND
    ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z0-9_]{1,80}$') AND
    ("claimToken" IS NULL OR length("claimToken") BETWEEN 8 AND 80) AND
    "expiresAt" > "consentRecordedAt"
  )
);
CREATE UNIQUE INDEX "PdfGraphSecondReviewRequest_one_per_page_uq"
  ON "PdfGraphSecondReviewRequest" ("ingestionRunId", "routingGeneration", "physicalPageIndex");
CREATE UNIQUE INDEX "PdfGraphSecondReviewRequest_invocationId_key"
  ON "PdfGraphSecondReviewRequest" ("invocationId");
CREATE INDEX "PdfGraphSecondReviewRequest_read_idx"
  ON "PdfGraphSecondReviewRequest" ("workspaceId", "sourceDocumentId", "physicalPageIndex");
CREATE INDEX "PdfGraphSecondReviewRequest_admission_idx"
  ON "PdfGraphSecondReviewRequest" ("status", "expiresAt", "consentRecordedAt");
ALTER TABLE "PdfGraphSecondReviewRequest"
  ADD CONSTRAINT "PdfGraphSecondReviewRequest_ingestion_run_fkey"
  FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId")
  REFERENCES "IngestionRun"("id", "sourceDocumentId", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
