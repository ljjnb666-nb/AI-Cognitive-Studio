-- Immutable, credential-free speech identity per Short Video generation run.
CREATE TABLE "ShortVideoSpeechExecutionPin" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT,
    "providerVoiceId" TEXT NOT NULL,
    "voiceVersion" TEXT,
    "speakingRate" DOUBLE PRECISION NOT NULL,
    "pitch" DOUBLE PRECISION NOT NULL,
    "style" TEXT,
    "language" TEXT NOT NULL,
    "outputFormat" TEXT NOT NULL,
    "voiceIdentityHash" TEXT NOT NULL,
    "audioVersion" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShortVideoSpeechExecutionPin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShortVideoSpeechExecutionPin_shortVideoGenerationRunId_key" ON "ShortVideoSpeechExecutionPin"("shortVideoGenerationRunId");
CREATE UNIQUE INDEX "ShortVideoSpeechExecutionPin_id_workspaceId_key" ON "ShortVideoSpeechExecutionPin"("id", "workspaceId");
CREATE UNIQUE INDEX "ShortVideoSpeechExecutionPin_shortVideoGenerationRunId_workspaceId_key" ON "ShortVideoSpeechExecutionPin"("shortVideoGenerationRunId", "workspaceId");
CREATE INDEX "ShortVideoSpeechExecutionPin_workspaceId_provider_model_idx" ON "ShortVideoSpeechExecutionPin"("workspaceId", "provider", "model");
ALTER TABLE "ShortVideoSpeechExecutionPin" ADD CONSTRAINT "ShortVideoSpeechExecutionPin_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortVideoSpeechExecutionPin" ADD CONSTRAINT "ShortVideoSpeechExecutionPin_shortVideoGenerationRunId_workspaceId_fkey" FOREIGN KEY ("shortVideoGenerationRunId", "workspaceId") REFERENCES "ShortVideoGenerationRun"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- One durable speech artifact per narration synthesis unit makes a consumed
-- ProviderSpeechResult exactly verifiable without retaining plaintext audio.
ALTER TABLE "ShortVideoAudioArtifact" ADD COLUMN "narrationId" TEXT;
ALTER TABLE "ShortVideoAudioArtifact" ADD COLUMN "unitOrdinal" INTEGER;
ALTER TABLE "ShortVideoAudioArtifact" ADD CONSTRAINT "ShortVideoAudioArtifact_unitOrdinal_nonnegative" CHECK ("unitOrdinal" IS NULL OR "unitOrdinal" >= 0);
CREATE UNIQUE INDEX "ShortVideoAudioArtifact_shortVideoGenerationRunId_narrationId_unitOrdinal_key" ON "ShortVideoAudioArtifact"("shortVideoGenerationRunId", "narrationId", "unitOrdinal");
CREATE INDEX "ShortVideoAudioArtifact_shortVideoGenerationRunId_narrationId_idx" ON "ShortVideoAudioArtifact"("shortVideoGenerationRunId", "narrationId");
ALTER TABLE "ShortVideoAudioArtifact" ADD CONSTRAINT "ShortVideoAudioArtifact_narrationId_shortVideoGenerationRunId_fkey" FOREIGN KEY ("narrationId", "shortVideoGenerationRunId") REFERENCES "ShortVideoNarration"("id", "shortVideoGenerationRunId") ON DELETE CASCADE ON UPDATE CASCADE;
