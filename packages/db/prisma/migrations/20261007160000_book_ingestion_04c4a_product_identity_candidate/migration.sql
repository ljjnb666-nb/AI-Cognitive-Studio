-- BOOK-INGESTION-04C-4A product identity candidate authority.
-- Strictly additive. Historical and non-EPUB extractions remain NULL.
-- The value is extraction-scoped evidence only; it does not promote into
-- Work/Edition and therefore cannot silently overwrite product identity.

ALTER TABLE "DocumentExtraction" ADD COLUMN "productIdentityCandidate" JSONB;
