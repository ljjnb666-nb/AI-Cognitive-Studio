-- Additive durable transport fences for the three non-Audio expensive runs.
-- Existing durable rows and their legacy deliveries are generation zero.
ALTER TABLE "BookAnalysisRun" ADD COLUMN "dispatchGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PodcastGenerationRun" ADD COLUMN "dispatchGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShortVideoGenerationRun" ADD COLUMN "dispatchGeneration" INTEGER NOT NULL DEFAULT 0;
