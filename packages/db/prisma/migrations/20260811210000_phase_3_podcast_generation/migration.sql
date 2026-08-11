-- CreateEnum
CREATE TYPE "PodcastEpisodeStatus" AS ENUM ('DRAFT', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "PodcastGenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PodcastGenerationStage" AS ENUM ('QUEUED', 'EPISODE_PLANNING', 'NARRATIVE_DESIGN', 'SEGMENT_OUTLINE', 'SEGMENT_DRAFTING', 'HUMANIZATION', 'GROUNDING_VALIDATION', 'FINALIZING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PodcastSegmentStatus" AS ENUM ('PLANNED', 'DRAFTED', 'HUMANIZED', 'GROUNDED');

-- CreateEnum
CREATE TYPE "PodcastUtteranceType" AS ENUM ('STATEMENT', 'QUESTION', 'REACTION', 'CHALLENGE', 'CLARIFICATION', 'EXAMPLE', 'TRANSITION', 'CALLBACK');

-- CreateEnum
CREATE TYPE "PodcastRevisionSource" AS ENUM ('GENERATED', 'REGENERATED', 'USER_EDIT');

-- CreateEnum
CREATE TYPE "PodcastRevisionStatus" AS ENUM ('FINAL', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PodcastEvaluationStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "PodcastProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PodcastProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastProjectSource" (
    "podcastProjectId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastProjectSource_pkey" PRIMARY KEY ("podcastProjectId","sourceDocumentId")
);

-- CreateTable
CREATE TABLE "PodcastStyleProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "tone" TEXT NOT NULL DEFAULT 'cognitive-conversation',
    "depth" INTEGER NOT NULL DEFAULT 7,
    "pace" INTEGER NOT NULL DEFAULT 5,
    "hostCount" INTEGER NOT NULL DEFAULT 2,
    "targetDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "targetAudience" TEXT NOT NULL DEFAULT 'general-curious',
    "formality" INTEGER NOT NULL DEFAULT 4,
    "humorLevel" INTEGER NOT NULL DEFAULT 3,
    "debateLevel" INTEGER NOT NULL DEFAULT 5,
    "storytellingLevel" INTEGER NOT NULL DEFAULT 5,
    "interruptionLevel" INTEGER NOT NULL DEFAULT 3,
    "disagreementLevel" INTEGER NOT NULL DEFAULT 5,
    "technicalDepth" INTEGER NOT NULL DEFAULT 5,
    "summaryDensity" INTEGER NOT NULL DEFAULT 3,
    "exampleDensity" INTEGER NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastStyleProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastHost" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "configurationVersion" INTEGER NOT NULL DEFAULT 1,
    "personaVersion" INTEGER NOT NULL DEFAULT 1,
    "ordinal" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "speakingStyle" TEXT NOT NULL,
    "knowledgeStyle" TEXT NOT NULL,
    "temperament" TEXT NOT NULL,
    "skepticism" INTEGER NOT NULL DEFAULT 5,
    "humor" INTEGER NOT NULL DEFAULT 3,
    "verbosity" INTEGER NOT NULL DEFAULT 5,
    "questionStyle" TEXT NOT NULL,
    "disagreementStyle" TEXT NOT NULL,
    "preferredSentenceLength" TEXT NOT NULL,
    "fillerPreference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PodcastHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastEpisode" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "styleProfileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "language" TEXT NOT NULL,
    "targetDurationMinutes" INTEGER NOT NULL,
    "estimatedDurationSeconds" INTEGER,
    "status" "PodcastEpisodeStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PodcastEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastGenerationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "styleProfileId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT,
    "modelVersionKey" TEXT NOT NULL,
    "hostConfigurationHash" TEXT NOT NULL,
    "hostConfigurationVersion" INTEGER NOT NULL,
    "generationIdentityHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PodcastGenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "PodcastGenerationStage" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "executionClaimToken" TEXT,
    "executionClaimedAt" TIMESTAMP(3),
    "executionLeaseUntil" TIMESTAMP(3),
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PodcastGenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastGenerationSource" (
    "podcastGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "chunkSetId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastGenerationSource_pkey" PRIMARY KEY ("podcastGenerationRunId","sourceDocumentId")
);

-- CreateTable
CREATE TABLE "EpisodePlan" (
    "id" TEXT NOT NULL,
    "podcastGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "centralQuestion" TEXT NOT NULL,
    "listenerStartingPoint" TEXT NOT NULL,
    "listenerTakeaway" TEXT NOT NULL,
    "coreThesis" TEXT NOT NULL,
    "tensions" JSONB NOT NULL,
    "surprisingIdeas" JSONB NOT NULL,
    "misconceptions" JSONB NOT NULL,
    "keyConcepts" JSONB NOT NULL,
    "candidateStories" JSONB NOT NULL,
    "candidateExamples" JSONB NOT NULL,
    "openQuestions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeNarrative" (
    "id" TEXT NOT NULL,
    "podcastGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "arcType" TEXT NOT NULL,
    "intellectualProgression" JSONB NOT NULL,
    "openingMove" TEXT NOT NULL,
    "closingMove" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeNarrative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeSegment" (
    "id" TEXT NOT NULL,
    "podcastGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "internalLabel" TEXT NOT NULL,
    "targetDurationSeconds" INTEGER NOT NULL,
    "estimatedDurationSeconds" INTEGER,
    "narrativeFunction" TEXT NOT NULL,
    "keyQuestions" JSONB NOT NULL,
    "requiredMemoryIds" JSONB NOT NULL,
    "optionalMemoryIds" JSONB NOT NULL,
    "disagreementReason" TEXT,
    "generationAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "status" "PodcastSegmentStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpisodeSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastPlanContextItem" (
    "id" TEXT NOT NULL,
    "podcastGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "chunkSetId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "memoryItemId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "chunkId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "selectionReason" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "evidenceSpans" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastPlanContextItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastSegmentContextItem" (
    "id" TEXT NOT NULL,
    "podcastGenerationRunId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "chunkSetId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "memoryItemId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "chunkId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "selectionReason" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "evidenceSpans" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastSegmentContextItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastUtterance" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "podcastGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "podcastProjectId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "speakerHostId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "draftText" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "utteranceType" "PodcastUtteranceType" NOT NULL,
    "substantive" BOOLEAN NOT NULL,
    "isDirectQuote" BOOLEAN NOT NULL DEFAULT false,
    "estimatedDurationMs" INTEGER NOT NULL,
    "humanizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastUtterance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastUtteranceEvidence" (
    "id" TEXT NOT NULL,
    "utteranceId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "podcastGenerationRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "chunkSetId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "memoryItemId" TEXT NOT NULL,
    "sourceBlockId" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "quoteText" TEXT,
    "quoteHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastUtteranceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastScriptRevision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "parentRevisionId" TEXT,
    "generationRunId" TEXT,
    "source" "PodcastRevisionSource" NOT NULL,
    "status" "PodcastRevisionStatus" NOT NULL DEFAULT 'FINAL',
    "scriptSnapshot" JSONB NOT NULL,
    "estimatedDurationSeconds" INTEGER NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastScriptRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrentPodcastScript" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentPodcastScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastEvaluationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "status" "PodcastEvaluationStatus" NOT NULL DEFAULT 'RUNNING',
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PodcastEvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastEvaluationResult" (
    "id" TEXT NOT NULL,
    "evaluationRunId" TEXT NOT NULL,
    "naturalnessScore" DOUBLE PRECISION NOT NULL,
    "groundingScore" DOUBLE PRECISION NOT NULL,
    "hostDifferentiationScore" DOUBLE PRECISION NOT NULL,
    "cognitiveValueScore" DOUBLE PRECISION NOT NULL,
    "structuralCoherenceScore" DOUBLE PRECISION NOT NULL,
    "repetitionScore" DOUBLE PRECISION NOT NULL,
    "aiFeelScore" DOUBLE PRECISION NOT NULL,
    "sourceCopyRiskScore" DOUBLE PRECISION NOT NULL,
    "contextBudgetScore" DOUBLE PRECISION NOT NULL,
    "fabricationBoundaryScore" DOUBLE PRECISION NOT NULL,
    "metrics" JSONB NOT NULL,
    "hardFailures" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastEvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PodcastProject_id_workspaceId_key" ON "PodcastProject"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "PodcastProjectSource_workspaceId_sourceDocumentId_idx" ON "PodcastProjectSource"("workspaceId", "sourceDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastStyleProfile_podcastProjectId_version_key" ON "PodcastStyleProfile"("podcastProjectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastStyleProfile_id_workspaceId_podcastProjectId_key" ON "PodcastStyleProfile"("id", "workspaceId", "podcastProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastHost_podcastProjectId_configurationVersion_ordinal_key" ON "PodcastHost"("podcastProjectId", "configurationVersion", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastHost_id_workspaceId_podcastProjectId_key" ON "PodcastHost"("id", "workspaceId", "podcastProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEpisode_id_workspaceId_key" ON "PodcastEpisode"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEpisode_id_workspaceId_podcastProjectId_key" ON "PodcastEpisode"("id", "workspaceId", "podcastProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastGenerationRun_jobId_key" ON "PodcastGenerationRun"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastGenerationRun_generationIdentityHash_key" ON "PodcastGenerationRun"("generationIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastGenerationRun_idempotencyKey_key" ON "PodcastGenerationRun"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastGenerationRun_id_workspaceId_key" ON "PodcastGenerationRun"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastGenerationRun_id_workspaceId_episodeId_key" ON "PodcastGenerationRun"("id", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastGenerationRun_episodeId_generationIdentityHash_key" ON "PodcastGenerationRun"("episodeId", "generationIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastGenerationSource_lineage_key" ON "PodcastGenerationSource"("podcastGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodePlan_podcastGenerationRunId_key" ON "EpisodePlan"("podcastGenerationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodePlan_id_podcastGenerationRunId_key" ON "EpisodePlan"("id", "podcastGenerationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodePlan_podcastGenerationRunId_workspaceId_episodeId_key" ON "EpisodePlan"("podcastGenerationRunId", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeNarrative_podcastGenerationRunId_key" ON "EpisodeNarrative"("podcastGenerationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeNarrative_podcastGenerationRunId_workspaceId_episode_key" ON "EpisodeNarrative"("podcastGenerationRunId", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeSegment_podcastGenerationRunId_ordinal_key" ON "EpisodeSegment"("podcastGenerationRunId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeSegment_id_podcastGenerationRunId_workspaceId_episod_key" ON "EpisodeSegment"("id", "podcastGenerationRunId", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastPlanContextItem_podcastGenerationRunId_memoryItemId_key" ON "PodcastPlanContextItem"("podcastGenerationRunId", "memoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastSegmentContextItem_segmentId_memoryItemId_key" ON "PodcastSegmentContextItem"("segmentId", "memoryItemId");

-- CreateIndex
CREATE INDEX "PodcastUtterance_episodeId_podcastGenerationRunId_ordinal_idx" ON "PodcastUtterance"("episodeId", "podcastGenerationRunId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastUtterance_segmentId_ordinal_key" ON "PodcastUtterance"("segmentId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastUtterance_id_segmentId_key" ON "PodcastUtterance"("id", "segmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastUtteranceEvidence_utteranceId_memoryItemId_sourceBlo_key" ON "PodcastUtteranceEvidence"("utteranceId", "memoryItemId", "sourceBlockId", "startOffset", "endOffset");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastScriptRevision_generationRunId_key" ON "PodcastScriptRevision"("generationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastScriptRevision_episodeId_revisionNumber_key" ON "PodcastScriptRevision"("episodeId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastScriptRevision_id_episodeId_key" ON "PodcastScriptRevision"("id", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastScriptRevision_id_workspaceId_episodeId_key" ON "PodcastScriptRevision"("id", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastScript_episodeId_key" ON "CurrentPodcastScript"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastScript_revisionId_key" ON "CurrentPodcastScript"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastScript_episodeId_workspaceId_key" ON "CurrentPodcastScript"("episodeId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentPodcastScript_revisionId_workspaceId_episodeId_key" ON "CurrentPodcastScript"("revisionId", "workspaceId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEvaluationRun_revisionId_evaluatorVersion_key" ON "PodcastEvaluationRun"("revisionId", "evaluatorVersion");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEvaluationResult_evaluationRunId_key" ON "PodcastEvaluationResult"("evaluationRunId");

-- AddForeignKey
ALTER TABLE "PodcastProject" ADD CONSTRAINT "PodcastProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastProjectSource" ADD CONSTRAINT "PodcastProjectSource_podcastProjectId_workspaceId_fkey" FOREIGN KEY ("podcastProjectId", "workspaceId") REFERENCES "PodcastProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastProjectSource" ADD CONSTRAINT "PodcastProjectSource_sourceDocumentId_workspaceId_fkey" FOREIGN KEY ("sourceDocumentId", "workspaceId") REFERENCES "SourceDocument"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastStyleProfile" ADD CONSTRAINT "PodcastStyleProfile_podcastProjectId_workspaceId_fkey" FOREIGN KEY ("podcastProjectId", "workspaceId") REFERENCES "PodcastProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastHost" ADD CONSTRAINT "PodcastHost_podcastProjectId_workspaceId_fkey" FOREIGN KEY ("podcastProjectId", "workspaceId") REFERENCES "PodcastProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEpisode" ADD CONSTRAINT "PodcastEpisode_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEpisode" ADD CONSTRAINT "PodcastEpisode_podcastProjectId_workspaceId_fkey" FOREIGN KEY ("podcastProjectId", "workspaceId") REFERENCES "PodcastProject"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEpisode" ADD CONSTRAINT "PodcastEpisode_styleProfileId_workspaceId_podcastProjectId_fkey" FOREIGN KEY ("styleProfileId", "workspaceId", "podcastProjectId") REFERENCES "PodcastStyleProfile"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastGenerationRun" ADD CONSTRAINT "PodcastGenerationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastGenerationRun" ADD CONSTRAINT "PodcastGenerationRun_episodeId_workspaceId_podcastProjectI_fkey" FOREIGN KEY ("episodeId", "workspaceId", "podcastProjectId") REFERENCES "PodcastEpisode"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastGenerationRun" ADD CONSTRAINT "PodcastGenerationRun_styleProfileId_workspaceId_podcastPro_fkey" FOREIGN KEY ("styleProfileId", "workspaceId", "podcastProjectId") REFERENCES "PodcastStyleProfile"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastGenerationRun" ADD CONSTRAINT "PodcastGenerationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastGenerationSource" ADD CONSTRAINT "PodcastGenerationSource_podcastGenerationRunId_workspaceId_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "PodcastGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastGenerationSource" ADD CONSTRAINT "PodcastGenerationSource_sourceDocumentId_workspaceId_fkey" FOREIGN KEY ("sourceDocumentId", "workspaceId") REFERENCES "SourceDocument"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastGenerationSource" ADD CONSTRAINT "PodcastGenerationSource_analysisRunId_workspaceId_sourceDo_fkey" FOREIGN KEY ("analysisRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId") REFERENCES "BookAnalysisRun"("id", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodePlan" ADD CONSTRAINT "EpisodePlan_podcastGenerationRunId_workspaceId_episodeId_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "PodcastGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeNarrative" ADD CONSTRAINT "EpisodeNarrative_podcastGenerationRunId_workspaceId_episod_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "PodcastGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeSegment" ADD CONSTRAINT "EpisodeSegment_podcastGenerationRunId_workspaceId_episodeI_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "PodcastGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeSegment" ADD CONSTRAINT "EpisodeSegment_episodeId_workspaceId_podcastProjectId_fkey" FOREIGN KEY ("episodeId", "workspaceId", "podcastProjectId") REFERENCES "PodcastEpisode"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastPlanContextItem" ADD CONSTRAINT "PodcastPlanContext_run_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "PodcastGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastPlanContextItem" ADD CONSTRAINT "PodcastPlanContext_source_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId") REFERENCES "PodcastGenerationSource"("podcastGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastPlanContextItem" ADD CONSTRAINT "PodcastPlanContextItem_memoryItemId_analysisRunId_workspac_fkey" FOREIGN KEY ("memoryItemId", "analysisRunId", "workspaceId", "extractionId") REFERENCES "BookMemoryItem"("id", "analysisRunId", "workspaceId", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastSegmentContextItem" ADD CONSTRAINT "PodcastSegmentContext_run_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "PodcastGenerationRun"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastSegmentContextItem" ADD CONSTRAINT "PodcastSegmentContextItem_segmentId_podcastGenerationRunId_fkey" FOREIGN KEY ("segmentId", "podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "EpisodeSegment"("id", "podcastGenerationRunId", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastSegmentContextItem" ADD CONSTRAINT "PodcastSegmentContext_source_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId") REFERENCES "PodcastGenerationSource"("podcastGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastSegmentContextItem" ADD CONSTRAINT "PodcastSegmentContextItem_memoryItemId_analysisRunId_works_fkey" FOREIGN KEY ("memoryItemId", "analysisRunId", "workspaceId", "extractionId") REFERENCES "BookMemoryItem"("id", "analysisRunId", "workspaceId", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastUtterance" ADD CONSTRAINT "PodcastUtterance_segmentId_podcastGenerationRunId_workspac_fkey" FOREIGN KEY ("segmentId", "podcastGenerationRunId", "workspaceId", "episodeId") REFERENCES "EpisodeSegment"("id", "podcastGenerationRunId", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastUtterance" ADD CONSTRAINT "PodcastUtterance_speakerHostId_workspaceId_podcastProjectI_fkey" FOREIGN KEY ("speakerHostId", "workspaceId", "podcastProjectId") REFERENCES "PodcastHost"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastUtteranceEvidence" ADD CONSTRAINT "PodcastUtteranceEvidence_utteranceId_segmentId_fkey" FOREIGN KEY ("utteranceId", "segmentId") REFERENCES "PodcastUtterance"("id", "segmentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastUtteranceEvidence" ADD CONSTRAINT "PodcastUtteranceEvidence_podcastGenerationRunId_workspaceI_fkey" FOREIGN KEY ("podcastGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId") REFERENCES "PodcastGenerationSource"("podcastGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastUtteranceEvidence" ADD CONSTRAINT "PodcastUtteranceEvidence_memoryItemId_analysisRunId_worksp_fkey" FOREIGN KEY ("memoryItemId", "analysisRunId", "workspaceId", "extractionId") REFERENCES "BookMemoryItem"("id", "analysisRunId", "workspaceId", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastUtteranceEvidence" ADD CONSTRAINT "PodcastUtteranceEvidence_sourceBlockId_extractionId_fkey" FOREIGN KEY ("sourceBlockId", "extractionId") REFERENCES "SourceBlock"("id", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastScriptRevision" ADD CONSTRAINT "PodcastScriptRevision_episodeId_workspaceId_fkey" FOREIGN KEY ("episodeId", "workspaceId") REFERENCES "PodcastEpisode"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastScriptRevision" ADD CONSTRAINT "PodcastScriptRevision_parentRevisionId_episodeId_fkey" FOREIGN KEY ("parentRevisionId", "episodeId") REFERENCES "PodcastScriptRevision"("id", "episodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastScriptRevision" ADD CONSTRAINT "PodcastScriptRevision_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "PodcastGenerationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentPodcastScript" ADD CONSTRAINT "CurrentPodcastScript_episodeId_workspaceId_fkey" FOREIGN KEY ("episodeId", "workspaceId") REFERENCES "PodcastEpisode"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentPodcastScript" ADD CONSTRAINT "CurrentPodcastScript_revisionId_workspaceId_episodeId_fkey" FOREIGN KEY ("revisionId", "workspaceId", "episodeId") REFERENCES "PodcastScriptRevision"("id", "workspaceId", "episodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEvaluationRun" ADD CONSTRAINT "PodcastEvaluationRun_revisionId_workspaceId_episodeId_fkey" FOREIGN KEY ("revisionId", "workspaceId", "episodeId") REFERENCES "PodcastScriptRevision"("id", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEvaluationResult" ADD CONSTRAINT "PodcastEvaluationResult_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "PodcastEvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
