-- Add durable encrypted handoff receipts for Provider Gateway speech executions.
CREATE TABLE "ProviderSpeechResult" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "ciphertext" TEXT,
    "iv" TEXT,
    "authTag" TEXT,
    "keyVersion" TEXT,
    "byteLength" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sampleRate" INTEGER NOT NULL,
    "channels" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "consumerKind" TEXT,
    "consumerKey" TEXT,
    "consumerFingerprint" TEXT,
    CONSTRAINT "ProviderSpeechResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderSpeechResult_invocationId_key" ON "ProviderSpeechResult"("invocationId");
CREATE UNIQUE INDEX "ProviderSpeechResult_attemptId_key" ON "ProviderSpeechResult"("attemptId");
CREATE UNIQUE INDEX "ProviderSpeechResult_id_workspaceId_key" ON "ProviderSpeechResult"("id", "workspaceId");
CREATE UNIQUE INDEX "ProviderSpeechResult_invocationId_workspaceId_key" ON "ProviderSpeechResult"("invocationId", "workspaceId");
CREATE UNIQUE INDEX "ProviderSpeechResult_invocationId_workspaceId_snapshotId_key" ON "ProviderSpeechResult"("invocationId", "workspaceId", "snapshotId");
CREATE UNIQUE INDEX "ProviderSpeechResult_attemptId_invocationId_workspaceId_key" ON "ProviderSpeechResult"("attemptId", "invocationId", "workspaceId");
CREATE INDEX "ProviderSpeechResult_workspaceId_invocationId_idx" ON "ProviderSpeechResult"("workspaceId", "invocationId");
CREATE INDEX "ProviderSpeechResult_workspaceId_consumedAt_idx" ON "ProviderSpeechResult"("workspaceId", "consumedAt");
ALTER TABLE "ProviderSpeechResult" ADD CONSTRAINT "ProviderSpeechResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderSpeechResult" ADD CONSTRAINT "ProviderSpeechResult_invocationId_workspaceId_snapshotId_fkey" FOREIGN KEY ("invocationId", "workspaceId", "snapshotId") REFERENCES "ProviderInvocation"("id", "workspaceId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderSpeechResult" ADD CONSTRAINT "ProviderSpeechResult_attemptId_invocationId_workspaceId_fkey" FOREIGN KEY ("attemptId", "invocationId", "workspaceId") REFERENCES "ProviderInvocationAttempt"("id", "invocationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderSpeechResult" ADD CONSTRAINT "ProviderSpeechResult_snapshotId_workspaceId_fkey" FOREIGN KEY ("snapshotId", "workspaceId") REFERENCES "ProviderExecutionSnapshot"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
