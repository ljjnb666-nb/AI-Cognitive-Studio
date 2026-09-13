-- Durable re-execution identity and server-side retry schedule for Book bootstrap.
ALTER TABLE "BookAnalysisBootstrap"
  ADD COLUMN "dispatchGeneration" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
CREATE INDEX "BookBootstrap_retry_idx" ON "BookAnalysisBootstrap"("status", "nextAttemptAt");
