-- BOOK-INGESTION-04C-4C4A: user-origin product identity correction audit.
-- Never rewrite historical EPUB evidence, promotion events or SourceDocument.
-- Correction service writes this append-only history in the same transaction
-- that changes the authoritative Work/Edition fields.

CREATE TABLE "ProductIdentityManualEdit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "editionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductIdentityManualEdit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductIdentityManualEdit_workspaceId_sourceId_createdAt_idx"
ON "ProductIdentityManualEdit"("workspaceId", "sourceId", "createdAt");

CREATE INDEX "ProductIdentityManualEdit_workspaceId_sourceDocumentId_createdAt_idx"
ON "ProductIdentityManualEdit"("workspaceId", "sourceDocumentId", "createdAt");

ALTER TABLE "ProductIdentityManualEdit"
ADD CONSTRAINT "ProductIdentityManualEdit_sourceId_workspaceId_fkey"
FOREIGN KEY ("sourceId", "workspaceId") REFERENCES "Source"("id", "workspaceId")
ON DELETE RESTRICT ON UPDATE CASCADE;
