-- No code path can legitimately transition a quarantine through this value:
-- durable ProviderSpeechResult recovery bypasses quarantine entirely.
ALTER TYPE "PodcastAudioPaidOutcomeResolution" RENAME TO "PodcastAudioPaidOutcomeResolution_old";
CREATE TYPE "PodcastAudioPaidOutcomeResolution" AS ENUM ('DEFINITIVE_REMOTE_FAILURE', 'ABANDON_AND_ALLOW_RETRY');
ALTER TABLE "PodcastAudioPaidOutcomeQuarantine" ALTER COLUMN "resolution" TYPE "PodcastAudioPaidOutcomeResolution" USING ("resolution"::text::"PodcastAudioPaidOutcomeResolution");
DROP TYPE "PodcastAudioPaidOutcomeResolution_old";
