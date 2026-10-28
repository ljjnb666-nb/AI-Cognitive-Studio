-- Source-bound, time-limited, non-authoritative visual graph candidate.
-- No original PDF bytes, page PNGs, canonical text, credentials or model prompts.
CREATE TABLE "PdfVisualReviewCandidate" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "ingestionRunId" TEXT NOT NULL,
  "routingGeneration" INTEGER NOT NULL,
  "physicalPageIndex" INTEGER NOT NULL,
  "sourcePdfSha256" TEXT NOT NULL,
  "sourcePngSha256" TEXT NOT NULL,
  "candidateJson" JSONB NOT NULL,
  "candidateSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PdfVisualReviewCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PdfVisualReviewCandidate_source_bounds" CHECK (
    "physicalPageIndex" >= 0 AND "routingGeneration" >= 1 AND
    "sourcePdfSha256" ~ '^[0-9a-f]{64}$' AND
    "sourcePngSha256" ~ '^[0-9a-f]{64}$' AND
    "candidateSha256" ~ '^[0-9a-f]{64}$' AND
    jsonb_typeof("candidateJson") = 'object' AND
    octet_length("candidateJson"::text) <= 32768 AND
    "expiresAt" > "createdAt"
  )
);
CREATE UNIQUE INDEX "PdfVisualReviewCandidate_identity_uq"
  ON "PdfVisualReviewCandidate" ("ingestionRunId", "physicalPageIndex", "routingGeneration", "sourcePngSha256");
CREATE INDEX "PdfVisualReviewCandidate_read_idx"
  ON "PdfVisualReviewCandidate" ("workspaceId", "sourceDocumentId", "physicalPageIndex", "expiresAt");
CREATE INDEX "PdfVisualReviewCandidate_expiry_idx"
  ON "PdfVisualReviewCandidate" ("expiresAt");
ALTER TABLE "PdfVisualReviewCandidate"
  ADD CONSTRAINT "PdfVisualReviewCandidate_ingestion_run_fkey"
  FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId")
  REFERENCES "IngestionRun"("id", "sourceDocumentId", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
