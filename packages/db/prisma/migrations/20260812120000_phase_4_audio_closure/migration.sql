-- Phase 4 closure: chunks are durable paid-call boundaries and duplicate host
-- identities are permitted only when the service explicitly opts into them.
DROP INDEX "AudioGenerationHostVoice_audioGenerationRunId_voiceIdentity_key";

CREATE TABLE "UtteranceSpeechChunk" (
    "id" TEXT NOT NULL,
    "speechPlanId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "synthesisIdentityHash" TEXT NOT NULL,
    "status" "AudioArtifactStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "sha256" TEXT,
    "sizeBytes" INTEGER,
    "mediaType" TEXT,
    "format" TEXT,
    "durationMs" INTEGER,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UtteranceSpeechChunk_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UtteranceSpeechChunk_speechPlanId_ordinal_key" ON "UtteranceSpeechChunk"("speechPlanId", "ordinal");
CREATE UNIQUE INDEX "UtteranceSpeechChunk_synthesisIdentityHash_key" ON "UtteranceSpeechChunk"("synthesisIdentityHash");
ALTER TABLE "UtteranceSpeechChunk" ADD CONSTRAINT "UtteranceSpeechChunk_speechPlanId_fkey" FOREIGN KEY ("speechPlanId") REFERENCES "UtteranceSpeechPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
