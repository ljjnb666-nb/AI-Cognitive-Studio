CREATE TYPE "UserCognitionReviewEventKind" AS ENUM ('MANUAL_REVIEW');

CREATE TABLE "UserCognitionReviewState" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryItemId" TEXT NOT NULL,
  "reviewCount" INTEGER NOT NULL DEFAULT 0,
  "lastReviewedAt" TIMESTAMP(3),
  "nextReviewAt" TIMESTAMP(3),
  "lastMasteryState" "TeachBackMasteryState",
  "lastMasteryAssessedAt" TIMESTAMP(3),
  "scheduleVersion" TEXT NOT NULL DEFAULT 'phase13-v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserCognitionReviewState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCognitionReviewEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryItemId" TEXT NOT NULL,
  "kind" "UserCognitionReviewEventKind" NOT NULL DEFAULT 'MANUAL_REVIEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserCognitionReviewEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserCognitionReviewState_workspaceId_userId_memoryItemId_key" ON "UserCognitionReviewState"("workspaceId", "userId", "memoryItemId");
CREATE INDEX "UserCognitionReviewState_workspaceId_userId_nextReviewAt_idx" ON "UserCognitionReviewState"("workspaceId", "userId", "nextReviewAt");
CREATE INDEX "UserCognitionReviewState_workspaceId_userId_lastMasteryState_idx" ON "UserCognitionReviewState"("workspaceId", "userId", "lastMasteryState");
CREATE UNIQUE INDEX "UserCognitionReviewEvent_id_workspaceId_key" ON "UserCognitionReviewEvent"("id", "workspaceId");
CREATE INDEX "UserCognitionReviewEvent_workspaceId_userId_memoryItemId_createdAt_idx" ON "UserCognitionReviewEvent"("workspaceId", "userId", "memoryItemId", "createdAt");

ALTER TABLE "UserCognitionReviewState" ADD CONSTRAINT "UserCognitionReviewState_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCognitionReviewState" ADD CONSTRAINT "UserCognitionReviewState_memoryItemId_workspaceId_fkey" FOREIGN KEY ("memoryItemId", "workspaceId") REFERENCES "BookMemoryItem"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserCognitionReviewEvent" ADD CONSTRAINT "UserCognitionReviewEvent_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCognitionReviewEvent" ADD CONSTRAINT "UserCognitionReviewEvent_memoryItemId_workspaceId_fkey" FOREIGN KEY ("memoryItemId", "workspaceId") REFERENCES "BookMemoryItem"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
