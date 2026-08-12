-- Phase 4 final acceptance: make all persisted audio edges carry their run,
-- episode, workspace and project lineage at the PostgreSQL layer.
ALTER TABLE "AudioGenerationHostVoice" ADD COLUMN "podcastProjectId" TEXT;
UPDATE "AudioGenerationHostVoice" AS "hostVoice"
SET "podcastProjectId" = "run"."podcastProjectId"
FROM "AudioGenerationRun" AS "run"
WHERE "run"."id" = "hostVoice"."audioGenerationRunId";
ALTER TABLE "AudioGenerationHostVoice" ALTER COLUMN "podcastProjectId" SET NOT NULL;

CREATE UNIQUE INDEX "AudioGenerationRun_id_workspaceId_episodeId_podcastProjectId_key"
  ON "AudioGenerationRun"("id", "workspaceId", "episodeId", "podcastProjectId");
CREATE UNIQUE INDEX "UtteranceSpeechPlan_id_audioGenerationRunId_workspaceId_episodeId_key"
  ON "UtteranceSpeechPlan"("id", "audioGenerationRunId", "workspaceId", "episodeId");

ALTER TABLE "AudioGenerationHostVoice"
  DROP CONSTRAINT "AudioGenerationHostVoice_audioGenerationRunId_workspaceId__fkey",
  DROP CONSTRAINT "AudioGenerationHostVoice_hostId_workspaceId_fkey",
  DROP CONSTRAINT "AudioGenerationHostVoice_voiceProfileId_workspaceId_fkey";
ALTER TABLE "AudioGenerationHostVoice"
  ADD CONSTRAINT "AudioGenerationHostVoice_run_project_lineage_fkey"
    FOREIGN KEY ("audioGenerationRunId", "workspaceId", "episodeId", "podcastProjectId")
    REFERENCES "AudioGenerationRun"("id", "workspaceId", "episodeId", "podcastProjectId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AudioGenerationHostVoice_host_project_lineage_fkey"
    FOREIGN KEY ("hostId", "workspaceId", "podcastProjectId")
    REFERENCES "PodcastHost"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AudioGenerationHostVoice_voice_project_lineage_fkey"
    FOREIGN KEY ("voiceProfileId", "workspaceId", "podcastProjectId")
    REFERENCES "PodcastVoiceProfile"("id", "workspaceId", "podcastProjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UtteranceAudioArtifact" DROP CONSTRAINT "UtteranceAudioArtifact_speechPlanId_fkey";
ALTER TABLE "UtteranceAudioArtifact"
  ADD CONSTRAINT "UtteranceAudioArtifact_plan_run_lineage_fkey"
    FOREIGN KEY ("speechPlanId", "audioGenerationRunId", "workspaceId", "episodeId")
    REFERENCES "UtteranceSpeechPlan"("id", "audioGenerationRunId", "workspaceId", "episodeId") ON DELETE CASCADE ON UPDATE CASCADE;
