-- One bounded, consented invocation for each immutable PDF ingestion generation.
-- Requests never store image bytes, model prompt or source content.
CREATE TABLE "PdfVisualReviewRequest" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "ingestionRunId" TEXT NOT NULL,
  "routingGeneration" INTEGER NOT NULL,
  "sourcePdfSha256" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "failureCode" TEXT,
  "claimToken" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PdfVisualReviewRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PdfVisualReviewRequest_validity" CHECK (
    "routingGeneration" >= 1 AND
    "sourcePdfSha256" ~ '^[0-9a-f]{64}$' AND
    "status" IN ('PENDING','RUNNING','SUCCEEDED','NO_FIGURES','FAILED') AND
    ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z0-9_]{1,80}$') AND
    ("claimToken" IS NULL OR length("claimToken") BETWEEN 8 AND 80) AND
    "expiresAt" > "createdAt"
  )
);
CREATE UNIQUE INDEX "PdfVisualReviewRequest_single_attempt_uq"
ON "PdfVisualReviewRequest" ("ingestionRunId", "routingGeneration");
CREATE INDEX "PdfVisualReviewRequest_pending_idx"
ON "PdfVisualReviewRequest" ("status", "expiresAt", "createdAt");
CREATE INDEX "PdfVisualReviewRequest_read_idx"
ON "PdfVisualReviewRequest" ("workspaceId", "sourceDocumentId");
ALTER TABLE "PdfVisualReviewRequest"
ADD CONSTRAINT "PdfVisualReviewRequest_ingestion_run_fkey"
FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId")
REFERENCES "IngestionRun"("id","sourceDocumentId","workspaceId")
ON DELETE CASCADE ON UPDATE CASCADE;
