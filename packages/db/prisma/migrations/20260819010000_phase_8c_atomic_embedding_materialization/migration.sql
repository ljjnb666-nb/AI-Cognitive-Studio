-- Checkpoint 2B: preserve a durable receipt tombstone after its encrypted payload is purged.
ALTER TABLE "ProviderEmbeddingResult"
  ALTER COLUMN "ciphertext" DROP NOT NULL,
  ALTER COLUMN "iv" DROP NOT NULL,
  ALTER COLUMN "authTag" DROP NOT NULL,
  ALTER COLUMN "keyVersion" DROP NOT NULL,
  ADD COLUMN "consumedAt" TIMESTAMP(3),
  ADD COLUMN "purgedAt" TIMESTAMP(3),
  ADD COLUMN "consumerKind" TEXT,
  ADD COLUMN "consumerKey" TEXT,
  ADD COLUMN "consumerFingerprint" TEXT;

CREATE INDEX "ProviderEmbeddingResult_workspaceId_consumedAt_idx"
  ON "ProviderEmbeddingResult"("workspaceId", "consumedAt");

ALTER TABLE "ProviderEmbeddingResult"
  ADD CONSTRAINT "ProviderEmbeddingResult_consumption_state_check"
  CHECK (
    (
      "consumedAt" IS NULL
      AND "purgedAt" IS NULL
      AND "consumerKind" IS NULL
      AND "consumerKey" IS NULL
      AND "consumerFingerprint" IS NULL
      AND "ciphertext" IS NOT NULL
      AND "iv" IS NOT NULL
      AND "authTag" IS NOT NULL
      AND "keyVersion" IS NOT NULL
    )
    OR
    (
      "consumedAt" IS NOT NULL
      AND "purgedAt" IS NOT NULL
      AND "consumerKind" IS NOT NULL
      AND "consumerKey" IS NOT NULL
      AND "consumerFingerprint" IS NOT NULL
      AND "ciphertext" IS NULL
      AND "iv" IS NULL
      AND "authTag" IS NULL
      AND "keyVersion" IS NULL
    )
  );
