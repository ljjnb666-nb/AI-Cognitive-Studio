-- Additive canonical version identity and durable stage checkpoint.
ALTER TABLE "BookAnalysisRun" ADD COLUMN "modelVersionKey" TEXT NOT NULL DEFAULT '', ADD COLUMN "analysisStage" TEXT NOT NULL DEFAULT 'QUEUED';
UPDATE "BookAnalysisRun" SET "modelVersionKey" = COALESCE("modelVersion", '');
ALTER TABLE "BookAnalysisRun" ADD CONSTRAINT "BookAnalysisRun_canonical_version_identity_key" UNIQUE ("chunkSetId", "pipelineVersion", "promptVersion", "provider", "model", "modelVersionKey");
