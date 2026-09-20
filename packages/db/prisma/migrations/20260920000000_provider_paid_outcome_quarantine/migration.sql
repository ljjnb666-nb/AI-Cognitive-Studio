CREATE TYPE "ProviderOutcomeRecoveryCapability" AS ENUM ('NONE', 'AUTHORITATIVE_LOOKUP', 'PROVIDER_IDEMPOTENT_REPLAY', 'ASYNC_OPERATION_HANDLE');
CREATE TYPE "PodcastAudioPaidOutcomeQuarantineStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "PodcastAudioPaidOutcomeResolution" AS ENUM ('DEFINITIVE_REMOTE_FAILURE', 'ABANDON_AND_ALLOW_RETRY', 'RECOVERED_DURABLE_RESULT');
ALTER TABLE "ProviderExecutionSnapshot" ADD COLUMN "outcomeRecoveryCapability" "ProviderOutcomeRecoveryCapability" NOT NULL DEFAULT 'NONE';
CREATE UNIQUE INDEX "AudioGenerationRun_id_workspaceId_key" ON "AudioGenerationRun"("id", "workspaceId");
CREATE TABLE "PodcastAudioPaidOutcomeQuarantine" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "audioGenerationRunId" TEXT NOT NULL, "semanticIdentityHash" TEXT NOT NULL, "providerInvocationId" TEXT NOT NULL, "providerInvocationAttemptId" TEXT NOT NULL, "status" "PodcastAudioPaidOutcomeQuarantineStatus" NOT NULL DEFAULT 'OPEN', "reasonCode" TEXT NOT NULL, "resolution" "PodcastAudioPaidOutcomeResolution", "resolutionActorId" TEXT, "resolutionReason" TEXT, "riskAcknowledged" BOOLEAN, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "PodcastAudioPaidOutcomeQuarantine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PodcastAudioPaidOutcomeQuarantine_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PodcastAudioPaidOutcomeQuarantine_run_fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId") REFERENCES "AudioGenerationRun"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PodcastAudioPaidOutcomeQuarantine_invocation_fkey" FOREIGN KEY ("providerInvocationId", "workspaceId") REFERENCES "ProviderInvocation"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PodcastAudioPaidOutcomeQuarantine_attempt_fkey" FOREIGN KEY ("providerInvocationAttemptId", "providerInvocationId", "workspaceId") REFERENCES "ProviderInvocationAttempt"("id", "invocationId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PodcastAudioPaidOutcomeQuarantine_workspaceId_semanticIdentityHash_status_idx" ON "PodcastAudioPaidOutcomeQuarantine"("workspaceId", "semanticIdentityHash", "status");
CREATE INDEX "PodcastAudioPaidOutcomeQuarantine_audioGenerationRunId_idx" ON "PodcastAudioPaidOutcomeQuarantine"("audioGenerationRunId");
CREATE UNIQUE INDEX "PodcastAudioPaidOutcomeQuarantine_one_open_semantic" ON "PodcastAudioPaidOutcomeQuarantine"("workspaceId", "semanticIdentityHash") WHERE "status" = 'OPEN';
