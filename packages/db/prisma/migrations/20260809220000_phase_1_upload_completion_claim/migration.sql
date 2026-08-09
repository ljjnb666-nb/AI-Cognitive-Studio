ALTER TYPE "UploadSessionStatus" ADD VALUE 'COMPLETING';

ALTER TABLE "UploadSession"
  ADD COLUMN "completionClaimToken" TEXT,
  ADD COLUMN "completionClaimedAt" TIMESTAMP(3),
  ADD COLUMN "completionLeaseUntil" TIMESTAMP(3);

CREATE INDEX "UploadSession_workspaceId_status_completionLeaseUntil_idx"
  ON "UploadSession"("workspaceId", "status", "completionLeaseUntil");
