-- Make the durable execution checkpoint database-enforced.
CREATE TYPE "AnalysisRunStage" AS ENUM ('QUEUED', 'CHUNK_ANALYSIS', 'SECTION_ANALYSIS', 'CHAPTER_ANALYSIS', 'BOOK_SYNTHESIS', 'MEMORY_FINALIZATION', 'EMBEDDINGS', 'FINALIZING', 'COMPLETED');
ALTER TABLE "BookAnalysisRun" ALTER COLUMN "analysisStage" DROP DEFAULT;
ALTER TABLE "BookAnalysisRun" ALTER COLUMN "analysisStage" TYPE "AnalysisRunStage" USING "analysisStage"::"AnalysisRunStage";
ALTER TABLE "BookAnalysisRun" ALTER COLUMN "analysisStage" SET DEFAULT 'QUEUED'::"AnalysisRunStage";
