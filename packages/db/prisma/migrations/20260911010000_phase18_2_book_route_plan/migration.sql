ALTER TABLE "BookAnalysisRun" ADD COLUMN "routePlan" JSONB, ADD COLUMN "routePlanHash" TEXT;
ALTER TABLE "BookAnalysisRun" DROP CONSTRAINT IF EXISTS "BookAnalysisRun_chunkSetId_pipelineVersion_promptVersion_provider_model_modelVersionKey_key";
CREATE INDEX "BookAnalysisRun_routePlanHash_idx" ON "BookAnalysisRun"("routePlanHash");
