-- Legacy #216-only DESTRUCTIVE schema rollback, never normal application rollback.
-- Prefer disabling optional OCR/review workers and reverting application code;
-- retain additive tables and their audit evidence.
-- Requires a verified backup, stopped workers and separate operator authorization:
-- SET acs.allow_destructive_ocr_receipt_rollback = 'after-backup-approved';
-- Rehearse inside BEGIN / ROLLBACK on an isolated database. All DDL is in one
-- atomic statement, so psql cannot continue a partial teardown after rejection.
DO $$
BEGIN
  IF current_setting('acs.allow_destructive_ocr_receipt_rollback', true)
       IS DISTINCT FROM 'after-backup-approved' THEN
    RAISE EXCEPTION 'OCR_SCHEMA_ROLLBACK_REQUIRES_EXPLICIT_AUTHORIZATION' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public."OcrModelReviewEvent"') IS NOT NULL THEN
    RAISE EXCEPTION 'OCR_SCHEMA_ROLLBACK_UNSUPPORTED_AFTER_MODEL_REVIEW' USING ERRCODE='55000';
  END IF;
  DROP TRIGGER "OcrPageExecution_immutable" ON "OcrPageExecution";
  DROP FUNCTION reject_ocr_receipt_update();
  DROP TABLE "OcrPageExecution";
  ALTER TABLE "OcrPageAttempt"
    DROP COLUMN "proposedTier", DROP COLUMN "admittedTier", DROP COLUMN "actualTier",
    DROP COLUMN "manifestDigest", DROP COLUMN "executionStatus", DROP COLUMN "fallbackReason",
    DROP COLUMN "sourceIdentity", DROP COLUMN "claimIdentity", DROP COLUMN "qualityStatus";
END;
$$;
-- No CASCADE or Prisma migration bookkeeping rewrite is performed here.
