-- Phase 8C Checkpoint 2A: encrypted, per-invocation durable embedding handoff receipts.
CREATE TABLE "ProviderEmbeddingResult" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "invocationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "authTag" TEXT NOT NULL,
  "keyVersion" TEXT NOT NULL,
  "vectorCount" INTEGER NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderEmbeddingResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderEmbeddingResult_invocationId_key" ON "ProviderEmbeddingResult"("invocationId");
CREATE UNIQUE INDEX "ProviderEmbeddingResult_attemptId_key" ON "ProviderEmbeddingResult"("attemptId");
CREATE UNIQUE INDEX "ProviderEmbeddingResult_id_workspaceId_key" ON "ProviderEmbeddingResult"("id", "workspaceId");
CREATE UNIQUE INDEX "ProviderEmbeddingResult_invocationId_workspaceId_key" ON "ProviderEmbeddingResult"("invocationId", "workspaceId");
CREATE UNIQUE INDEX "ProviderEmbeddingResult_attemptId_invocationId_workspaceId_key" ON "ProviderEmbeddingResult"("attemptId", "invocationId", "workspaceId");
CREATE INDEX "ProviderEmbeddingResult_workspaceId_invocationId_idx" ON "ProviderEmbeddingResult"("workspaceId", "invocationId");
ALTER TABLE "ProviderEmbeddingResult" ADD CONSTRAINT "ProviderEmbeddingResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderEmbeddingResult" ADD CONSTRAINT "ProviderEmbeddingResult_invocationId_workspaceId_fkey" FOREIGN KEY ("invocationId", "workspaceId") REFERENCES "ProviderInvocation"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderEmbeddingResult" ADD CONSTRAINT "ProviderEmbeddingResult_attemptId_invocationId_workspaceId_fkey" FOREIGN KEY ("attemptId", "invocationId", "workspaceId") REFERENCES "ProviderInvocationAttempt"("id", "invocationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderEmbeddingResult" ADD CONSTRAINT "ProviderEmbeddingResult_snapshotId_workspaceId_fkey" FOREIGN KEY ("snapshotId", "workspaceId") REFERENCES "ProviderExecutionSnapshot"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
