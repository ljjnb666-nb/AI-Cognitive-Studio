CREATE TABLE "WorkspaceResourcePolicy" (
  "workspaceId" TEXT PRIMARY KEY REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "dailyUnitLimit" INTEGER NOT NULL DEFAULT 1000000 CHECK ("dailyUnitLimit" >= 0),
  "runUnitLimit" INTEGER NOT NULL DEFAULT 300000 CHECK ("runUnitLimit" >= 0)
);
CREATE TABLE "ProviderResourceReservation" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "scopeKey" TEXT NOT NULL,
  "units" INTEGER NOT NULL CHECK ("units" >= 0),
  "chargedUnits" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ProviderResourceReservation_period_idx" ON "ProviderResourceReservation" ("workspaceId", "createdAt");
CREATE INDEX "ProviderResourceReservation_scope_idx" ON "ProviderResourceReservation" ("workspaceId", "scopeKey");
