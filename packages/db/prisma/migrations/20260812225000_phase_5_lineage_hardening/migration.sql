-- Phase 5: make scene/run and revision/run ownership database-enforced.
ALTER TABLE "ShortVideoNarrationEvidence" ADD COLUMN "narrationId" TEXT;
UPDATE "ShortVideoNarrationEvidence" AS evidence
SET "narrationId" = narration."id"
FROM "ShortVideoNarration" AS narration
WHERE narration."shortVideoGenerationRunId" = evidence."shortVideoGenerationRunId"
  AND narration."sceneId" = evidence."sceneId";
ALTER TABLE "ShortVideoNarrationEvidence" ALTER COLUMN "narrationId" SET NOT NULL;

ALTER TABLE "ShortVideoScene"
  ADD CONSTRAINT "ShortVideoScene_id_shortVideoGenerationRunId_key"
  UNIQUE ("id", "shortVideoGenerationRunId");
ALTER TABLE "ShortVideoNarration"
  ADD CONSTRAINT "ShortVideoNarration_id_shortVideoGenerationRunId_key"
  UNIQUE ("id", "shortVideoGenerationRunId");
ALTER TABLE "ShortVideoNarration"
  ADD CONSTRAINT "ShortVideoNarration_sceneId_shortVideoGenerationRunId_key"
  UNIQUE ("sceneId", "shortVideoGenerationRunId");
ALTER TABLE "ShortVideoRevision"
  ADD CONSTRAINT "ShortVideoRevision_run_lineage_key"
  UNIQUE ("generationRunId", "workspaceId", "shortVideoProjectId");

ALTER TABLE "ShortVideoNarration"
  DROP CONSTRAINT "ShortVideoNarration_sceneId_fkey",
  ADD CONSTRAINT "ShortVideoNarration_sceneId_shortVideoGenerationRunId_fkey"
  FOREIGN KEY ("sceneId", "shortVideoGenerationRunId")
  REFERENCES "ShortVideoScene"("id", "shortVideoGenerationRunId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortVideoNarrationEvidence"
  ADD CONSTRAINT "ShortVideoNarrationEvidence_narrationId_shortVideoGenerationRunId_fkey"
  FOREIGN KEY ("narrationId", "shortVideoGenerationRunId")
  REFERENCES "ShortVideoNarration"("id", "shortVideoGenerationRunId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortVideoCaptionCue"
  DROP CONSTRAINT "ShortVideoCaptionCue_sceneId_fkey",
  ADD CONSTRAINT "ShortVideoCaptionCue_sceneId_shortVideoGenerationRunId_fkey"
  FOREIGN KEY ("sceneId", "shortVideoGenerationRunId")
  REFERENCES "ShortVideoScene"("id", "shortVideoGenerationRunId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortVideoVisualAsset"
  ADD CONSTRAINT "ShortVideoVisualAsset_sceneId_shortVideoGenerationRunId_fkey"
  FOREIGN KEY ("sceneId", "shortVideoGenerationRunId")
  REFERENCES "ShortVideoScene"("id", "shortVideoGenerationRunId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortVideoAudioArtifact"
  ADD CONSTRAINT "ShortVideoAudioArtifact_sceneId_shortVideoGenerationRunId_fkey"
  FOREIGN KEY ("sceneId", "shortVideoGenerationRunId")
  REFERENCES "ShortVideoScene"("id", "shortVideoGenerationRunId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortVideoRevision"
  DROP CONSTRAINT "ShortVideoRevision_generationRunId_fkey",
  ADD CONSTRAINT "ShortVideoRevision_generationRunId_workspaceId_shortVideoProjectId_fkey"
  FOREIGN KEY ("generationRunId", "workspaceId", "shortVideoProjectId")
  REFERENCES "ShortVideoGenerationRun"("id", "workspaceId", "shortVideoProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;
