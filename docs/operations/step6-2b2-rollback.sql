-- Operator rollback only. Stop upgraded workers and export receipt evidence
-- before applying for real. Rehearse inside BEGIN/ROLLBACK on a test database.
DROP TRIGGER "OcrPageExecution_immutable" ON "OcrPageExecution";
DROP FUNCTION reject_ocr_receipt_update();
DROP TABLE "OcrPageExecution";
ALTER TABLE "OcrPageAttempt"
  DROP COLUMN "proposedTier", DROP COLUMN "admittedTier", DROP COLUMN "actualTier",
  DROP COLUMN "manifestDigest", DROP COLUMN "executionStatus", DROP COLUMN "fallbackReason",
  DROP COLUMN "sourceIdentity", DROP COLUMN "claimIdentity", DROP COLUMN "qualityStatus";
-- Prisma migration bookkeeping must be resolved only after the operator chooses
-- to retain this rollback. This script intentionally does not rewrite history.
