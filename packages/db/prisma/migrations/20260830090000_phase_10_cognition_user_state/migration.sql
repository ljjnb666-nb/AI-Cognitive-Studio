-- Phase 10: version-scoped, user-owned cognition lifecycle state.
CREATE TYPE "UserCognitionStateKind" AS ENUM ('SAVED', 'ARCHIVED');

ALTER TABLE "BookMemoryItem"
  ADD CONSTRAINT "BookMemoryItem_id_workspaceId_key" UNIQUE ("id", "workspaceId");

CREATE TABLE "UserCognitionState" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryItemId" TEXT NOT NULL,
  "state" "UserCognitionStateKind" NOT NULL DEFAULT 'SAVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserCognitionState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserCognitionState_workspaceId_userId_memoryItemId_key"
  ON "UserCognitionState"("workspaceId", "userId", "memoryItemId");
CREATE INDEX "UserCognitionState_workspaceId_userId_state_idx"
  ON "UserCognitionState"("workspaceId", "userId", "state");

ALTER TABLE "UserCognitionState"
  ADD CONSTRAINT "UserCognitionState_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCognitionState"
  ADD CONSTRAINT "UserCognitionState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCognitionState"
  ADD CONSTRAINT "UserCognitionState_memoryItemId_workspaceId_fkey"
  FOREIGN KEY ("memoryItemId", "workspaceId") REFERENCES "BookMemoryItem"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
