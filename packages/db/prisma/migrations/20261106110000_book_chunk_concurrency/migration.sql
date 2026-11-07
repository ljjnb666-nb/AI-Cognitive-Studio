ALTER TABLE "WorkspaceResourcePolicy" ADD COLUMN "bookChunkConcurrency" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "WorkspaceResourcePolicy" ADD CONSTRAINT "WorkspaceResourcePolicy_bookChunkConcurrency_check" CHECK ("bookChunkConcurrency" BETWEEN 1 AND 4);
