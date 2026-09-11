-- The Phase 18.2 route-plan migration originally targeted Prisma's generated
-- constraint name. Existing deployments use this explicitly mapped legacy
-- constraint instead, so remove it in a forward-only migration.
ALTER TABLE "BookAnalysisRun"
  DROP CONSTRAINT IF EXISTS "BookAnalysisRun_canonical_version_identity_key";
