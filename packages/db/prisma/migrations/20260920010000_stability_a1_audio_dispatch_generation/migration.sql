-- Podcast Audio transport generations fence stale BullMQ deliveries without
-- changing existing generation-zero rows or Redis payloads.
ALTER TABLE "AudioGenerationRun"
  ADD COLUMN "dispatchGeneration" INTEGER NOT NULL DEFAULT 0;
