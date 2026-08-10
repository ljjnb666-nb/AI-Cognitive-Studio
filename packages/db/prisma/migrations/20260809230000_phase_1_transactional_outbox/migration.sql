CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DISPATCHED', 'FAILED');

ALTER TABLE "OutboxEvent"
  ADD COLUMN "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "OutboxEvent_status_leaseUntil_createdAt_idx"
  ON "OutboxEvent"("status", "leaseUntil", "createdAt");
