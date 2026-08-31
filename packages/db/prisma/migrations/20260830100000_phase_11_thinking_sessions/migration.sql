-- Phase 11: personal, version-pinned thinking sessions.
CREATE TYPE "ThinkingSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED');
CREATE TYPE "ThinkingSessionMessageRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "ThinkingSession" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryItemId" TEXT NOT NULL,
  "status" "ThinkingSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ThinkingSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ThinkingSessionMessage" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "role" "ThinkingSessionMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "clientMessageId" TEXT,
  "replyToMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ThinkingSessionMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ThinkingSession_id_workspaceId_key" ON "ThinkingSession"("id", "workspaceId");
CREATE INDEX "ThinkingSession_workspaceId_userId_updatedAt_idx" ON "ThinkingSession"("workspaceId", "userId", "updatedAt");
CREATE INDEX "ThinkingSession_workspaceId_memoryItemId_idx" ON "ThinkingSession"("workspaceId", "memoryItemId");
CREATE UNIQUE INDEX "ThinkingSessionMessage_sessionId_ordinal_key" ON "ThinkingSessionMessage"("sessionId", "ordinal");
CREATE UNIQUE INDEX "ThinkingSessionMessage_sessionId_clientMessageId_key" ON "ThinkingSessionMessage"("sessionId", "clientMessageId");
CREATE UNIQUE INDEX "ThinkingSessionMessage_sessionId_replyToMessageId_key" ON "ThinkingSessionMessage"("sessionId", "replyToMessageId");
CREATE INDEX "ThinkingSessionMessage_workspaceId_sessionId_createdAt_idx" ON "ThinkingSessionMessage"("workspaceId", "sessionId", "createdAt");

ALTER TABLE "ThinkingSession" ADD CONSTRAINT "ThinkingSession_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThinkingSession" ADD CONSTRAINT "ThinkingSession_memoryItemId_workspaceId_fkey" FOREIGN KEY ("memoryItemId", "workspaceId") REFERENCES "BookMemoryItem"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ThinkingSessionMessage" ADD CONSTRAINT "ThinkingSessionMessage_sessionId_workspaceId_fkey" FOREIGN KEY ("sessionId", "workspaceId") REFERENCES "ThinkingSession"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
