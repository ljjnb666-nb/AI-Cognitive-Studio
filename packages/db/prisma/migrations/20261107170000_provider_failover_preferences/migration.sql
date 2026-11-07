-- Pre-configure backup model order. All existing workspaces default to OFF.
-- The runtime executor is not active; this table stores no secret, provider
-- invocation, model response, or implicit paid-call authorization.
CREATE TABLE "ProviderFailoverPreference" (
  "workspaceId" TEXT NOT NULL,
  "routeSlot" TEXT NOT NULL,
  "requestedEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "maxSwitches" INTEGER NOT NULL DEFAULT 0,
  "candidates" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "preferenceHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFailoverPreference_pkey" PRIMARY KEY ("workspaceId", "routeSlot"),
  CONSTRAINT "ProviderFailoverPreference_limits" CHECK (
    "maxSwitches" BETWEEN 0 AND 2 AND "revision" >= 1
    AND "preferenceHash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("candidates") = 'array'
    AND jsonb_array_length("candidates") <= 2
    AND (NOT "requestedEnabled" OR ("maxSwitches" >= 1 AND jsonb_array_length("candidates") >= "maxSwitches"))
  )
);
ALTER TABLE "ProviderFailoverPreference" ADD CONSTRAINT "ProviderFailoverPreference_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
