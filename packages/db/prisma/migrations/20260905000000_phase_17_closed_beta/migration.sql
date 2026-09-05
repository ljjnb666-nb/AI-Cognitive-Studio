-- Phase 17 is additive: beta product access and first-party telemetry only.
CREATE TYPE "BetaParticipantRole" AS ENUM ('TESTER', 'OPERATOR');
CREATE TYPE "BetaParticipantStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'REMOVED');
CREATE TYPE "BetaFeedbackCategory" AS ENUM ('BUG', 'CONFUSION', 'QUALITY', 'FEATURE', 'OTHER');
CREATE TYPE "BetaFeedbackDimension" AS ENUM ('OVERALL', 'PODCAST_NATURALNESS', 'PODCAST_VALUE', 'COGNITION_VALUE', 'USABILITY');
CREATE TYPE "BetaFeedbackStatus" AS ENUM ('NEW', 'REVIEWED');

CREATE TABLE "BetaParticipant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "cohort" TEXT NOT NULL,
  "role" "BetaParticipantRole" NOT NULL DEFAULT 'TESTER',
  "status" "BetaParticipantStatus" NOT NULL DEFAULT 'ACTIVE',
  "consentVersion" TEXT NOT NULL,
  "consentedAt" TIMESTAMP(3) NOT NULL,
  "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawnAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BetaParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BetaInvite" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "cohort" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "redeemedAt" TIMESTAMP(3),
  "redeemedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BetaInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductEvent" (
  "id" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "clientEventId" TEXT NOT NULL,
  "sessionId" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "route" TEXT,
  "properties" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BetaFeedback" (
  "id" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "workspaceId" TEXT,
  "category" "BetaFeedbackCategory" NOT NULL,
  "dimension" "BetaFeedbackDimension",
  "rating" INTEGER,
  "message" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "route" TEXT,
  "status" "BetaFeedbackStatus" NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "BetaFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BetaParticipant_userId_key" ON "BetaParticipant"("userId");
CREATE INDEX "BetaParticipant_userId_status_idx" ON "BetaParticipant"("userId", "status");
CREATE UNIQUE INDEX "BetaInvite_tokenHash_key" ON "BetaInvite"("tokenHash");
CREATE INDEX "BetaInvite_tokenHash_idx" ON "BetaInvite"("tokenHash");
CREATE UNIQUE INDEX "ProductEvent_participantId_clientEventId_key" ON "ProductEvent"("participantId", "clientEventId");
CREATE INDEX "ProductEvent_participantId_eventName_occurredAt_idx" ON "ProductEvent"("participantId", "eventName", "occurredAt");
CREATE INDEX "ProductEvent_workspaceId_occurredAt_idx" ON "ProductEvent"("workspaceId", "occurredAt");
CREATE INDEX "BetaFeedback_participantId_createdAt_idx" ON "BetaFeedback"("participantId", "createdAt");

ALTER TABLE "BetaParticipant" ADD CONSTRAINT "BetaParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BetaInvite" ADD CONSTRAINT "BetaInvite_redeemedByUserId_fkey" FOREIGN KEY ("redeemedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "BetaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BetaFeedback" ADD CONSTRAINT "BetaFeedback_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "BetaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BetaFeedback" ADD CONSTRAINT "BetaFeedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
