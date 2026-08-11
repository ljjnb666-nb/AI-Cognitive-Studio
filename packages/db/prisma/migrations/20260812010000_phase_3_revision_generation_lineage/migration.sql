ALTER TABLE "PodcastScriptRevision"
  DROP CONSTRAINT "PodcastScriptRevision_generationRunId_fkey";

ALTER TABLE "PodcastScriptRevision"
  ADD CONSTRAINT "PodcastScriptRevision_generationRunId_workspaceId_episodeId_fkey"
  FOREIGN KEY ("generationRunId", "workspaceId", "episodeId")
  REFERENCES "PodcastGenerationRun"("id", "workspaceId", "episodeId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
