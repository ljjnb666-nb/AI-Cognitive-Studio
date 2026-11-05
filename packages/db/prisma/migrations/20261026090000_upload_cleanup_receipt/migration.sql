ALTER TABLE "UploadSession" ADD COLUMN "temporaryCleanedAt" TIMESTAMP(3);
CREATE INDEX "UploadSession_cleanup_idx" ON "UploadSession" ("expiresAt") WHERE "temporaryCleanedAt" IS NULL;
