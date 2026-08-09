-- System jobs have no user owner; durable business lifecycle metadata remains in PostgreSQL.
ALTER TABLE "Job" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Job" ADD COLUMN "queueJobId" TEXT;
ALTER TABLE "Job" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Job" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "Job" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "Job_queueJobId_key" ON "Job"("queueJobId");
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
CREATE INDEX "Job_correlationId_idx" ON "Job"("correlationId");
