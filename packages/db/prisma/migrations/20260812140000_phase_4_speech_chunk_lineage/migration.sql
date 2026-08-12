-- Keep chunk artifacts tied to the exact plan/run/workspace/episode lineage.
ALTER TABLE "UtteranceSpeechChunk" ADD COLUMN "audioGenerationRunId" TEXT;
ALTER TABLE "UtteranceSpeechChunk" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "UtteranceSpeechChunk" ADD COLUMN "episodeId" TEXT;

UPDATE "UtteranceSpeechChunk" AS "chunk"
SET "audioGenerationRunId" = "plan"."audioGenerationRunId",
    "workspaceId" = "plan"."workspaceId",
    "episodeId" = "plan"."episodeId"
FROM "UtteranceSpeechPlan" AS "plan"
WHERE "plan"."id" = "chunk"."speechPlanId";

ALTER TABLE "UtteranceSpeechChunk"
  ALTER COLUMN "audioGenerationRunId" SET NOT NULL,
  ALTER COLUMN "workspaceId" SET NOT NULL,
  ALTER COLUMN "episodeId" SET NOT NULL,
  DROP CONSTRAINT "UtteranceSpeechChunk_speechPlanId_fkey";

ALTER TABLE "UtteranceSpeechChunk"
  ADD CONSTRAINT "UtteranceSpeechChunk_plan_run_lineage_fkey"
    FOREIGN KEY ("speechPlanId", "audioGenerationRunId", "workspaceId", "episodeId")
    REFERENCES "UtteranceSpeechPlan"("id", "audioGenerationRunId", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;
