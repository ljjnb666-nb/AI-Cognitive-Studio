-- Phase 16 performance and engineering-cost observability. Additive only.
ALTER TABLE "ProviderUsageEvent" ADD COLUMN "cachedInputTokens" INTEGER;
