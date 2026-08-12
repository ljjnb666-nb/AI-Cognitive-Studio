-- CreateEnum
CREATE TYPE "AudioGenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AudioGenerationStage" AS ENUM ('QUEUED', 'SPEECH_PREPARATION', 'UTTERANCE_SYNTHESIS', 'SEGMENT_ASSEMBLY', 'EPISODE_ASSEMBLY', 'AUDIO_NORMALIZATION', 'QUALITY_VALIDATION', 'FINALIZING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AudioArtifactStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "PodcastVoiceProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVoiceId" TEXT NOT NULL,
    "voiceVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT,
    "speakingRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "pitch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "energy" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "style" TEXT,
    "pauseStyle" TEXT,
    "pronunciationProfileVersion" TEXT NOT NULL DEFAULT 'v1',
    "providerOptions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastVoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastEpisodeAudioConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "outputFormat" TEXT NOT NULL DEFAULT 'wav',
    "sampleRate" INTEGER NOT NULL DEFAULT 24000,
    "channels" INTEGER NOT NULL DEFAULT 1,
    "targetLufs" DOUBLE PRECISION NOT NULL DEFAULT -16,
    "truePeakLimitDb" DOUBLE PRECISION NOT NULL DEFAULT -1,
    "defaultPauseMs" INTEGER NOT NULL DEFAULT 420,
    "shortReactionPauseMs" INTEGER NOT NULL DEFAULT 120,
    "interruptionPauseMs" INTEGER NOT NULL DEFAULT 80,
    "segmentBoundaryPauseMs" INTEGER NOT NULL DEFAULT 850,
    "speakingRateMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "normalizeLoudness" BOOLEAN NOT NULL DEFAULT true,
    "trimLeadingSilence" BOOLEAN NOT NULL DEFAULT true,
    "trimTrailingSilence" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastEpisodeAudioConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioGenerationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "scriptRevisionId" TEXT NOT NULL,
    "audioConfigId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT,
    "pipelineVersion" TEXT NOT NULL,
    "speechPreparationVersion" TEXT NOT NULL,
    "assemblyVersion" TEXT NOT NULL,
    "normalizationVersion" TEXT NOT NULL,
    "outputFormat" TEXT NOT NULL,
    "generationIdentityHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "AudioGenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "AudioGenerationStage" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "executionClaimToken" TEXT,
    "executionClaimedAt" TIMESTAMP(3),
    "executionLeaseUntil" TIMESTAMP(3),
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AudioGenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioGenerationHostVoice" (
    "id" TEXT NOT NULL,
    "audioGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "voiceProfileId" TEXT NOT NULL,
    "voiceIdentityHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioGenerationHostVoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtteranceSpeechPlan" (
    "id" TEXT NOT NULL,
    "audioGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "utteranceId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "spokenText" TEXT NOT NULL,
    "originalTextHash" TEXT NOT NULL,
    "spokenTextHash" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "speechRole" TEXT NOT NULL,
    "pauseBeforeMs" INTEGER NOT NULL,
    "pauseAfterMs" INTEGER NOT NULL,
    "speakingRate" DOUBLE PRECISION NOT NULL,
    "prosodyHints" JSONB,
    "pronunciationRules" JSONB,
    "isInterruptive" BOOLEAN NOT NULL DEFAULT false,
    "isShortReaction" BOOLEAN NOT NULL DEFAULT false,
    "preparationVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UtteranceSpeechPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtteranceAudioArtifact" (
    "id" TEXT NOT NULL,
    "audioGenerationRunId" TEXT NOT NULL,
    "speechPlanId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "synthesisIdentityHash" TEXT NOT NULL,
    "status" "AudioArtifactStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "sampleRate" INTEGER NOT NULL,
    "channels" INTEGER NOT NULL,
    "providerMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UtteranceAudioArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentAudioArtifact" (
    "id" TEXT NOT NULL,
    "audioGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "assemblyIdentityHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentAudioArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeAudioArtifact" (
    "id" TEXT NOT NULL,
    "audioGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "integratedLufs" DOUBLE PRECISION,
    "truePeakDb" DOUBLE PRECISION,
    "loudnessRange" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeAudioArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastAudioRevision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "scriptRevisionId" TEXT NOT NULL,
    "audioGenerationRunId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "parentRevisionId" TEXT,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "status" "AudioArtifactStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastAudioRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrentPodcastAudio" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentPodcastAudio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioEvaluationRun" (
    "id" TEXT NOT NULL,
    "audioGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "status" "AudioArtifactStatus" NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AudioEvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioEvaluationResult" (
    "id" TEXT NOT NULL,
    "evaluationRunId" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "hardFailures" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "decodeSuccess" BOOLEAN NOT NULL,
    "durationDriftRatio" DOUBLE PRECISION NOT NULL,
    "silenceRatio" DOUBLE PRECISION NOT NULL,
    "maxSilenceGapMs" INTEGER NOT NULL,
    "averageGapMs" INTEGER NOT NULL,
    "hostVoiceDistinctness" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioEvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PodcastVoiceProfile_workspaceId_provider_providerVoiceId_vo_key" ON "PodcastVoiceProfile"("workspaceId", "provider", "providerVoiceId", "voiceVersion", "model", "modelVersion");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastVoiceProfile_id_workspaceId_key" ON "PodcastVoiceProfile"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastVoiceProfile_id_workspaceId_podcastProjectId_key" ON "PodcastVoiceProfile"("id", "workspaceId", "podcastProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEpisodeAudioConfig_episodeId_version_key" ON "PodcastEpisodeAudioConfig"("episodeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEpisodeAudioConfig_id_workspaceId_podcastProjectId_e_key" ON "PodcastEpisodeAudioConfig"("id", "workspaceId", "podcastProjectId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationRun_jobId_key" ON "AudioGenerationRun"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationRun_idempotencyKey_key" ON "AudioGenerationRun"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationRun_episodeId_generationIdentityHash_key" ON "AudioGenerationRun"("episodeId", "generationIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationRun_id_workspaceId_episodeId_key" ON "AudioGenerationRun"("id", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationHostVoice_audioGenerationRunId_hostId_key" ON "AudioGenerationHostVoice"("audioGenerationRunId", "hostId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationHostVoice_audioGenerationRunId_voiceIdentity_key" ON "AudioGenerationHostVoice"("audioGenerationRunId", "voiceIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "UtteranceSpeechPlan_audioGenerationRunId_utteranceId_prepar_key" ON "UtteranceSpeechPlan"("audioGenerationRunId", "utteranceId", "preparationVersion");

-- CreateIndex
CREATE UNIQUE INDEX "UtteranceAudioArtifact_audioGenerationRunId_synthesisIdenti_key" ON "UtteranceAudioArtifact"("audioGenerationRunId", "synthesisIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "SegmentAudioArtifact_audioGenerationRunId_segmentId_assembl_key" ON "SegmentAudioArtifact"("audioGenerationRunId", "segmentId", "assemblyIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeAudioArtifact_audioGenerationRunId_kind_key" ON "EpisodeAudioArtifact"("audioGenerationRunId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastAudioRevision_audioGenerationRunId_key" ON "PodcastAudioRevision"("audioGenerationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastAudioRevision_episodeId_revisionNumber_key" ON "PodcastAudioRevision"("episodeId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastAudioRevision_id_workspaceId_episodeId_key" ON "PodcastAudioRevision"("id", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastAudio_episodeId_key" ON "CurrentPodcastAudio"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastAudio_revisionId_key" ON "CurrentPodcastAudio"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastAudio_episodeId_workspaceId_key" ON "CurrentPodcastAudio"("episodeId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastAudio_revisionId_workspaceId_episodeId_key" ON "CurrentPodcastAudio"("revisionId", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioEvaluationRun_audioGenerationRunId_evaluatorVersion_key" ON "AudioEvaluationRun"("audioGenerationRunId", "evaluatorVersion");

-- CreateIndex
CREATE UNIQUE INDEX "AudioEvaluationResult_evaluationRunId_key" ON "AudioEvaluationResult"("evaluationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastHost_id_workspaceId_key" ON "PodcastHost"("id", "workspaceId");

-- AddForeignKey
ALTER TABLE "PodcastVoiceProfile" ADD CONSTRAINT "PodcastVoiceProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastVoiceProfile" ADD CONSTRAINT "PodcastVoiceProfile_podcastProjectId_workspaceId_fkey" FOREIGN KEY ("podcastProjectId", "workspaceId") REFERENCES "PodcastProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEpisodeAudioConfig" ADD CONSTRAINT "PodcastEpisodeAudioConfig_podcastProjectId_workspaceId_fkey" FOREIGN KEY ("podcastProjectId", "workspaceId") REFERENCES "PodcastProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEpisodeAudioConfig" ADD CONSTRAINT "PodcastEpisodeAudioConfig_episodeId_workspaceId_podcastPro_fkey" FOREIGN KEY ("episodeId", "workspaceId", "podcastProjectId") REFERENCES "PodcastEpisode"("id", "workspaceId", "podcastProjectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationRun" ADD CONSTRAINT "AudioGenerationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationRun" ADD CONSTRAINT "AudioGenerationRun_episodeId_workspaceId_podcastProjectId_fkey" FOREIGN KEY ("episodeId", "workspaceId", "podcastProjectId") REFERENCES "PodcastEpisode"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationRun" ADD CONSTRAINT "AudioGenerationRun_scriptRevisionId_workspaceId_episodeId_fkey" FOREIGN KEY ("scriptRevisionId", "workspaceId", "episodeId") REFERENCES "PodcastScriptRevision"("id", "workspaceId", "episodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationRun" ADD CONSTRAINT "AudioGenerationRun_audioConfigId_workspaceId_podcastProjec_fkey" FOREIGN KEY ("audioConfigId", "workspaceId", "podcastProjectId", "episodeId") REFERENCES "PodcastEpisodeAudioConfig"("id", "workspaceId", "podcastProjectId", "episodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationRun" ADD CONSTRAINT "AudioGenerationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationHostVoice" ADD CONSTRAINT "AudioGenerationHostVoice_audioGenerationRunId_workspaceId__fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId") REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationHostVoice" ADD CONSTRAINT "AudioGenerationHostVoice_hostId_workspaceId_fkey" FOREIGN KEY ("hostId", "workspaceId") REFERENCES "PodcastHost"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationHostVoice" ADD CONSTRAINT "AudioGenerationHostVoice_voiceProfileId_workspaceId_fkey" FOREIGN KEY ("voiceProfileId", "workspaceId") REFERENCES "PodcastVoiceProfile"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtteranceSpeechPlan" ADD CONSTRAINT "UtteranceSpeechPlan_audioGenerationRunId_workspaceId_episo_fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId") REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtteranceAudioArtifact" ADD CONSTRAINT "UtteranceAudioArtifact_audioGenerationRunId_workspaceId_ep_fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId") REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtteranceAudioArtifact" ADD CONSTRAINT "UtteranceAudioArtifact_speechPlanId_fkey" FOREIGN KEY ("speechPlanId") REFERENCES "UtteranceSpeechPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentAudioArtifact" ADD CONSTRAINT "SegmentAudioArtifact_audioGenerationRunId_workspaceId_epis_fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId") REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeAudioArtifact" ADD CONSTRAINT "EpisodeAudioArtifact_audioGenerationRunId_workspaceId_epis_fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId") REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastAudioRevision" ADD CONSTRAINT "PodcastAudioRevision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastAudioRevision" ADD CONSTRAINT "PodcastAudioRevision_episodeId_workspaceId_fkey" FOREIGN KEY ("episodeId", "workspaceId") REFERENCES "PodcastEpisode"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastAudioRevision" ADD CONSTRAINT "PodcastAudioRevision_scriptRevisionId_workspaceId_episodeI_fkey" FOREIGN KEY ("scriptRevisionId", "workspaceId", "episodeId") REFERENCES "PodcastScriptRevision"("id", "workspaceId", "episodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastAudioRevision" ADD CONSTRAINT "PodcastAudioRevision_audioGenerationRunId_workspaceId_epis_fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId") REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentPodcastAudio" ADD CONSTRAINT "CurrentPodcastAudio_episodeId_workspaceId_fkey" FOREIGN KEY ("episodeId", "workspaceId") REFERENCES "PodcastEpisode"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentPodcastAudio" ADD CONSTRAINT "CurrentPodcastAudio_revisionId_workspaceId_episodeId_fkey" FOREIGN KEY ("revisionId", "workspaceId", "episodeId") REFERENCES "PodcastAudioRevision"("id", "workspaceId", "episodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioEvaluationRun" ADD CONSTRAINT "AudioEvaluationRun_audioGenerationRunId_workspaceId_episod_fkey" FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId") REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioEvaluationResult" ADD CONSTRAINT "AudioEvaluationResult_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "AudioEvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
