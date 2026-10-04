-- BOOK-INGESTION-02 EPUB native ingestion.
-- Strictly additive: historical rows (and every non-EPUB format) keep NULL.

ALTER TABLE "DocumentExtraction" ADD COLUMN "formatMetadata" JSONB;
