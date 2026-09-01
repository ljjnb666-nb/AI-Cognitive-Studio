CREATE TYPE "TeachBackAttemptStatus" AS ENUM ('PENDING_ASSESSMENT', 'ASSESSED');
CREATE TYPE "TeachBackMasteryState" AS ENUM ('NEEDS_REVIEW', 'DEVELOPING', 'DEMONSTRATED');

CREATE TABLE "TeachBackAttempt" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryItemId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" "TeachBackAttemptStatus" NOT NULL DEFAULT 'PENDING_ASSESSMENT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "assessedAt" TIMESTAMP(3),
  CONSTRAINT "TeachBackAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeachBackAssessment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "masteryState" "TeachBackMasteryState" NOT NULL,
  "rubric" JSONB NOT NULL,
  "feedback" TEXT NOT NULL,
  "nextPrompt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeachBackAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeachBackAttempt_id_workspaceId_key" ON "TeachBackAttempt"("id", "workspaceId");
CREATE INDEX "TeachBackAttempt_workspaceId_userId_createdAt_idx" ON "TeachBackAttempt"("workspaceId", "userId", "createdAt");
CREATE INDEX "TeachBackAttempt_workspaceId_memoryItemId_createdAt_idx" ON "TeachBackAttempt"("workspaceId", "memoryItemId", "createdAt");
CREATE UNIQUE INDEX "TeachBackAssessment_attemptId_key" ON "TeachBackAssessment"("attemptId");
CREATE UNIQUE INDEX "TeachBackAssessment_attemptId_workspaceId_key" ON "TeachBackAssessment"("attemptId", "workspaceId");
CREATE INDEX "TeachBackAssessment_workspaceId_createdAt_idx" ON "TeachBackAssessment"("workspaceId", "createdAt");

ALTER TABLE "TeachBackAttempt" ADD CONSTRAINT "TeachBackAttempt_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachBackAttempt" ADD CONSTRAINT "TeachBackAttempt_memoryItemId_workspaceId_fkey" FOREIGN KEY ("memoryItemId", "workspaceId") REFERENCES "BookMemoryItem"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TeachBackAssessment" ADD CONSTRAINT "TeachBackAssessment_attemptId_workspaceId_fkey" FOREIGN KEY ("attemptId", "workspaceId") REFERENCES "TeachBackAttempt"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
