-- CreateEnum
CREATE TYPE "ShortVideoGenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShortVideoGenerationStage" AS ENUM ('QUEUED', 'CONTEXT_RETRIEVAL', 'VIDEO_PLANNING', 'NARRATIVE_GENERATION', 'SCENE_PLANNING', 'NARRATION_SYNTHESIS', 'VISUAL_PREPARATION', 'CAPTION_GENERATION', 'VIDEO_RENDERING', 'QUALITY_VALIDATION', 'FINALIZING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ShortVideoSceneType" AS ENUM ('HOOK', 'QUESTION', 'CLAIM', 'CONTRAST', 'EVIDENCE', 'QUOTE', 'CONCEPT', 'LIST', 'DIAGRAM', 'REFRAME', 'CALLBACK', 'ENDING');

-- CreateTable
CREATE TABLE "ShortVideoProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShortVideoProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoProjectSource" (
    "shortVideoProjectId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoProjectSource_pkey" PRIMARY KEY ("shortVideoProjectId","sourceDocumentId")
);

-- CreateTable
CREATE TABLE "ShortVideoStyleProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortVideoProjectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "tone" TEXT NOT NULL DEFAULT 'clear, curious, grounded',
    "pace" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "hookStyle" TEXT NOT NULL DEFAULT 'counterintuitive',
    "informationDensity" INTEGER NOT NULL DEFAULT 5,
    "sentenceStyle" TEXT NOT NULL DEFAULT 'asymmetric',
    "captionDensity" INTEGER NOT NULL DEFAULT 5,
    "visualDensity" INTEGER NOT NULL DEFAULT 5,
    "keywordEmphasis" INTEGER NOT NULL DEFAULT 5,
    "transitionIntensity" INTEGER NOT NULL DEFAULT 4,
    "textAnimationIntensity" INTEGER NOT NULL DEFAULT 4,
    "endingStyle" TEXT NOT NULL DEFAULT 'memorable reframe',
    "targetDurationSeconds" INTEGER NOT NULL DEFAULT 60,
    "safeArea" JSONB NOT NULL DEFAULT '{"top":180,"bottom":260,"left":72,"right":72}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoStyleProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoGenerationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortVideoProjectId" TEXT NOT NULL,
    "styleProfileId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT,
    "modelVersionKey" TEXT NOT NULL DEFAULT '',
    "promptVersion" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL,
    "retrievalVersion" TEXT NOT NULL,
    "scenePlannerVersion" TEXT NOT NULL,
    "captionVersion" TEXT NOT NULL,
    "audioVersion" TEXT NOT NULL,
    "renderVersion" TEXT NOT NULL,
    "generationIdentityHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT,
    "status" "ShortVideoGenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "ShortVideoGenerationStage" NOT NULL DEFAULT 'QUEUED',
    "executionClaimToken" TEXT,
    "executionClaimedAt" TIMESTAMP(3),
    "executionLeaseUntil" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ShortVideoGenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoGenerationSource" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortVideoProjectId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "chunkSetId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoGenerationSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoPlan" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "centralQuestion" TEXT NOT NULL,
    "viewerAssumption" TEXT NOT NULL,
    "coreInsight" TEXT NOT NULL,
    "cognitiveShift" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "supportingIdeas" JSONB NOT NULL,
    "evidenceStrategy" TEXT NOT NULL,
    "ending" TEXT NOT NULL,
    "targetDurationSeconds" INTEGER NOT NULL,
    "tone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoScene" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortVideoProjectId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sceneType" "ShortVideoSceneType" NOT NULL,
    "targetStartMs" INTEGER NOT NULL,
    "targetEndMs" INTEGER NOT NULL,
    "targetDurationMs" INTEGER NOT NULL,
    "narrationText" TEXT NOT NULL,
    "visualIntent" TEXT NOT NULL,
    "primaryText" TEXT NOT NULL,
    "secondaryText" TEXT,
    "keywords" JSONB NOT NULL,
    "layoutTemplate" TEXT NOT NULL,
    "motionPreset" TEXT NOT NULL,
    "transitionIntent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoNarration" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "estimatedDurationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoNarration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoNarrationEvidence" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "chunkSetId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "memoryItemId" TEXT,
    "sourceBlockId" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "quoteText" TEXT,
    "quoteHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoNarrationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoCaptionCue" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "emphasis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoCaptionCue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoVisualAsset" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "sceneId" TEXT,
    "kind" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "storageKey" TEXT,
    "sha256" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoVisualAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoAudioArtifact" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "sceneId" TEXT,
    "synthesisIdentityHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "voiceIdentity" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoAudioArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoRenderArtifact" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "container" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "videoCodec" TEXT NOT NULL,
    "audioCodec" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoRenderArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoRevision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortVideoProjectId" TEXT NOT NULL,
    "generationRunId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "container" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "videoCodec" TEXT NOT NULL,
    "audioCodec" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrentShortVideo" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortVideoProjectId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentShortVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoEvaluationRun" (
    "id" TEXT NOT NULL,
    "shortVideoGenerationRunId" TEXT NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "status" "ShortVideoGenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ShortVideoEvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortVideoEvaluationResult" (
    "id" TEXT NOT NULL,
    "evaluationRunId" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "hardFailures" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortVideoEvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoProject_id_workspaceId_key" ON "ShortVideoProject"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoStyleProfile_shortVideoProjectId_version_key" ON "ShortVideoStyleProfile"("shortVideoProjectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoStyleProfile_id_workspaceId_shortVideoProjectId_key" ON "ShortVideoStyleProfile"("id", "workspaceId", "shortVideoProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoGenerationRun_jobId_key" ON "ShortVideoGenerationRun"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoGenerationRun_idempotencyKey_key" ON "ShortVideoGenerationRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ShortVideoGenerationRun_workspaceId_status_executionLeaseUn_idx" ON "ShortVideoGenerationRun"("workspaceId", "status", "executionLeaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoGenerationRun_shortVideoProjectId_generationIdent_key" ON "ShortVideoGenerationRun"("shortVideoProjectId", "generationIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoGenerationRun_id_workspaceId_shortVideoProjectId_key" ON "ShortVideoGenerationRun"("id", "workspaceId", "shortVideoProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoGenerationSource_shortVideoGenerationRunId_source_key" ON "ShortVideoGenerationSource"("shortVideoGenerationRunId", "sourceDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoPlan_shortVideoGenerationRunId_key" ON "ShortVideoPlan"("shortVideoGenerationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoScene_shortVideoGenerationRunId_ordinal_key" ON "ShortVideoScene"("shortVideoGenerationRunId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoScene_id_shortVideoGenerationRunId_workspaceId_sh_key" ON "ShortVideoScene"("id", "shortVideoGenerationRunId", "workspaceId", "shortVideoProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoScene_id_shortVideoGenerationRunId_workspaceId_key" ON "ShortVideoScene"("id", "shortVideoGenerationRunId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoNarration_sceneId_key" ON "ShortVideoNarration"("sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoNarration_shortVideoGenerationRunId_ordinal_key" ON "ShortVideoNarration"("shortVideoGenerationRunId", "ordinal");

-- CreateIndex
CREATE INDEX "ShortVideoNarrationEvidence_shortVideoGenerationRunId_scene_idx" ON "ShortVideoNarrationEvidence"("shortVideoGenerationRunId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoCaptionCue_shortVideoGenerationRunId_ordinal_key" ON "ShortVideoCaptionCue"("shortVideoGenerationRunId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoAudioArtifact_shortVideoGenerationRunId_synthesis_key" ON "ShortVideoAudioArtifact"("shortVideoGenerationRunId", "synthesisIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoRenderArtifact_shortVideoGenerationRunId_key" ON "ShortVideoRenderArtifact"("shortVideoGenerationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoRevision_generationRunId_key" ON "ShortVideoRevision"("generationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoRevision_shortVideoProjectId_revisionNumber_key" ON "ShortVideoRevision"("shortVideoProjectId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoRevision_id_workspaceId_shortVideoProjectId_key" ON "ShortVideoRevision"("id", "workspaceId", "shortVideoProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentShortVideo_shortVideoProjectId_key" ON "CurrentShortVideo"("shortVideoProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentShortVideo_revisionId_key" ON "CurrentShortVideo"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentShortVideo_shortVideoProjectId_workspaceId_key" ON "CurrentShortVideo"("shortVideoProjectId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentShortVideo_revisionId_workspaceId_shortVideoProjectI_key" ON "CurrentShortVideo"("revisionId", "workspaceId", "shortVideoProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoEvaluationRun_shortVideoGenerationRunId_evaluator_key" ON "ShortVideoEvaluationRun"("shortVideoGenerationRunId", "evaluatorVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ShortVideoEvaluationResult_evaluationRunId_key" ON "ShortVideoEvaluationResult"("evaluationRunId");

-- AddForeignKey
ALTER TABLE "ShortVideoProject" ADD CONSTRAINT "ShortVideoProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoProjectSource" ADD CONSTRAINT "ShortVideoProjectSource_shortVideoProjectId_workspaceId_fkey" FOREIGN KEY ("shortVideoProjectId", "workspaceId") REFERENCES "ShortVideoProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoProjectSource" ADD CONSTRAINT "ShortVideoProjectSource_sourceDocumentId_workspaceId_fkey" FOREIGN KEY ("sourceDocumentId", "workspaceId") REFERENCES "SourceDocument"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoStyleProfile" ADD CONSTRAINT "ShortVideoStyleProfile_shortVideoProjectId_workspaceId_fkey" FOREIGN KEY ("shortVideoProjectId", "workspaceId") REFERENCES "ShortVideoProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoGenerationRun" ADD CONSTRAINT "ShortVideoGenerationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoGenerationRun" ADD CONSTRAINT "ShortVideoGenerationRun_shortVideoProjectId_workspaceId_fkey" FOREIGN KEY ("shortVideoProjectId", "workspaceId") REFERENCES "ShortVideoProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoGenerationRun" ADD CONSTRAINT "ShortVideoGenerationRun_styleProfileId_workspaceId_shortVi_fkey" FOREIGN KEY ("styleProfileId", "workspaceId", "shortVideoProjectId") REFERENCES "ShortVideoStyleProfile"("id", "workspaceId", "shortVideoProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoGenerationRun" ADD CONSTRAINT "ShortVideoGenerationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoGenerationSource" ADD CONSTRAINT "ShortVideoGenerationSource_shortVideoGenerationRunId_works_fkey" FOREIGN KEY ("shortVideoGenerationRunId", "workspaceId", "shortVideoProjectId") REFERENCES "ShortVideoGenerationRun"("id", "workspaceId", "shortVideoProjectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoGenerationSource" ADD CONSTRAINT "ShortVideoGenerationSource_sourceDocumentId_workspaceId_fkey" FOREIGN KEY ("sourceDocumentId", "workspaceId") REFERENCES "SourceDocument"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoPlan" ADD CONSTRAINT "ShortVideoPlan_shortVideoGenerationRunId_fkey" FOREIGN KEY ("shortVideoGenerationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoScene" ADD CONSTRAINT "ShortVideoScene_shortVideoGenerationRunId_workspaceId_shor_fkey" FOREIGN KEY ("shortVideoGenerationRunId", "workspaceId", "shortVideoProjectId") REFERENCES "ShortVideoGenerationRun"("id", "workspaceId", "shortVideoProjectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoNarration" ADD CONSTRAINT "ShortVideoNarration_shortVideoGenerationRunId_fkey" FOREIGN KEY ("shortVideoGenerationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoNarration" ADD CONSTRAINT "ShortVideoNarration_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ShortVideoScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoNarrationEvidence" ADD CONSTRAINT "ShortVideoNarrationEvidence_sceneId_shortVideoGenerationRu_fkey" FOREIGN KEY ("sceneId", "shortVideoGenerationRunId", "workspaceId") REFERENCES "ShortVideoScene"("id", "shortVideoGenerationRunId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoNarrationEvidence" ADD CONSTRAINT "ShortVideoNarrationEvidence_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "SourceBlock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoCaptionCue" ADD CONSTRAINT "ShortVideoCaptionCue_shortVideoGenerationRunId_fkey" FOREIGN KEY ("shortVideoGenerationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoCaptionCue" ADD CONSTRAINT "ShortVideoCaptionCue_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ShortVideoScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoVisualAsset" ADD CONSTRAINT "ShortVideoVisualAsset_shortVideoGenerationRunId_fkey" FOREIGN KEY ("shortVideoGenerationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoAudioArtifact" ADD CONSTRAINT "ShortVideoAudioArtifact_shortVideoGenerationRunId_fkey" FOREIGN KEY ("shortVideoGenerationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoRenderArtifact" ADD CONSTRAINT "ShortVideoRenderArtifact_shortVideoGenerationRunId_fkey" FOREIGN KEY ("shortVideoGenerationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoRevision" ADD CONSTRAINT "ShortVideoRevision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoRevision" ADD CONSTRAINT "ShortVideoRevision_shortVideoProjectId_workspaceId_fkey" FOREIGN KEY ("shortVideoProjectId", "workspaceId") REFERENCES "ShortVideoProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoRevision" ADD CONSTRAINT "ShortVideoRevision_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentShortVideo" ADD CONSTRAINT "CurrentShortVideo_shortVideoProjectId_workspaceId_fkey" FOREIGN KEY ("shortVideoProjectId", "workspaceId") REFERENCES "ShortVideoProject"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentShortVideo" ADD CONSTRAINT "CurrentShortVideo_revisionId_workspaceId_shortVideoProject_fkey" FOREIGN KEY ("revisionId", "workspaceId", "shortVideoProjectId") REFERENCES "ShortVideoRevision"("id", "workspaceId", "shortVideoProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoEvaluationRun" ADD CONSTRAINT "ShortVideoEvaluationRun_shortVideoGenerationRunId_fkey" FOREIGN KEY ("shortVideoGenerationRunId") REFERENCES "ShortVideoGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortVideoEvaluationResult" ADD CONSTRAINT "ShortVideoEvaluationResult_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "ShortVideoEvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
