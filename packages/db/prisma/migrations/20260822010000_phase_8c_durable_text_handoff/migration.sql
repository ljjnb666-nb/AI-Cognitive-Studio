CREATE TABLE "ProviderTextResult" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "invocationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "ciphertext" TEXT,
  "iv" TEXT,
  "authTag" TEXT,
  "keyVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "purgedAt" TIMESTAMP(3),
  "consumerKind" TEXT,
  "consumerKey" TEXT,
  "consumerFingerprint" TEXT,
  CONSTRAINT "ProviderTextResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderTextResult_invocationId_key" ON "ProviderTextResult"("invocationId");
CREATE UNIQUE INDEX "ProviderTextResult_attemptId_key" ON "ProviderTextResult"("attemptId");
CREATE UNIQUE INDEX "ProviderTextResult_id_workspaceId_key" ON "ProviderTextResult"("id", "workspaceId");
CREATE UNIQUE INDEX "ProviderTextResult_invocationId_workspaceId_key" ON "ProviderTextResult"("invocationId", "workspaceId");
CREATE UNIQUE INDEX "ProviderTextResult_invocationId_workspaceId_snapshotId_key" ON "ProviderTextResult"("invocationId", "workspaceId", "snapshotId");
CREATE UNIQUE INDEX "ProviderTextResult_attemptId_invocationId_workspaceId_key" ON "ProviderTextResult"("attemptId", "invocationId", "workspaceId");
CREATE INDEX "ProviderTextResult_workspaceId_invocationId_idx" ON "ProviderTextResult"("workspaceId", "invocationId");
CREATE INDEX "ProviderTextResult_workspaceId_consumedAt_idx" ON "ProviderTextResult"("workspaceId", "consumedAt");
ALTER TABLE "ProviderTextResult" ADD CONSTRAINT "ProviderTextResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderTextResult" ADD CONSTRAINT "ProviderTextResult_invocationId_workspaceId_snapshotId_fkey" FOREIGN KEY ("invocationId", "workspaceId", "snapshotId") REFERENCES "ProviderInvocation"("id", "workspaceId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderTextResult" ADD CONSTRAINT "ProviderTextResult_attemptId_invocationId_workspaceId_fkey" FOREIGN KEY ("attemptId", "invocationId", "workspaceId") REFERENCES "ProviderInvocationAttempt"("id", "invocationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderTextResult" ADD CONSTRAINT "ProviderTextResult_snapshotId_workspaceId_fkey" FOREIGN KEY ("snapshotId", "workspaceId") REFERENCES "ProviderExecutionSnapshot"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderTextResult" ADD CONSTRAINT "ProviderTextResult_consumption_state_check" CHECK (("consumedAt" IS NULL AND "purgedAt" IS NULL AND "consumerKind" IS NULL AND "consumerKey" IS NULL AND "consumerFingerprint" IS NULL AND "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "authTag" IS NOT NULL AND "keyVersion" IS NOT NULL) OR ("consumedAt" IS NOT NULL AND "purgedAt" IS NOT NULL AND "consumerKind" IS NOT NULL AND "consumerKey" IS NOT NULL AND "consumerFingerprint" IS NOT NULL AND "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL AND "keyVersion" IS NULL));
