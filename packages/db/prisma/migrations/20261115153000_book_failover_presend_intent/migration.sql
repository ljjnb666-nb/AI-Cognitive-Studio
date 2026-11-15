-- Freeze the exact Gateway request identity BEFORE any possible network send.
-- Existing #249 ledger rows remain nullable but are unsafe to replay without
-- manual reconciliation; this migration must not backfill fictitious intent.
ALTER TABLE "BookFailoverCheckpoint"
  ADD COLUMN "sendIntentKey" TEXT,
  ADD COLUMN "sendIntentInputHash" TEXT,
  ADD COLUMN "sendIntentAt" TIMESTAMP(3);
ALTER TABLE "BookFailoverCheckpoint"
  ADD CONSTRAINT "BookFailoverCheckpoint_sendIntent_integrity" CHECK (
    (
      "sendIntentKey" IS NULL
      AND "sendIntentInputHash" IS NULL
      AND "sendIntentAt" IS NULL
    ) OR (
      "sendIntentKey" IS NOT NULL
      AND length("sendIntentKey") BETWEEN 1 AND 2048
      AND "sendIntentInputHash" ~ '^[a-f0-9]{64}$'
      AND "sendIntentAt" IS NOT NULL
    )
  );
