-- BOOK-INGESTION-01 canonical contract hardening.
-- Strictly additive: historical rows keep NULL for all three new columns.

CREATE TYPE "ExtractionQualityStatus" AS ENUM ('UNKNOWN', 'ACCEPTED', 'DEGRADED', 'REQUIRES_FALLBACK', 'REJECTED');

ALTER TABLE "DocumentExtraction" ADD COLUMN "canonicalSchemaVersion" TEXT;
ALTER TABLE "DocumentExtraction" ADD COLUMN "qualityStatus" "ExtractionQualityStatus";
ALTER TABLE "DocumentExtraction" ADD COLUMN "qualityMetadata" JSONB;
