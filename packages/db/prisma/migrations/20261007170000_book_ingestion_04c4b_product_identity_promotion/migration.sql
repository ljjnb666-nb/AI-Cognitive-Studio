-- BOOK-INGESTION-04C-4B controlled product identity promotion.
-- Promotion is explicit and current-extraction fenced. Existing Work/Edition
-- values are never overwritten by this migration or by the promotion service.

CREATE TYPE "ProductIdentityPromotionStatus" AS ENUM ('APPLIED', 'NOOP', 'CONFLICT', 'BLOCKED');

CREATE TABLE "ProductIdentityPromotion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "status" "ProductIdentityPromotionStatus" NOT NULL,
    "reasonCode" TEXT,
    "workId" TEXT,
    "editionId" TEXT,
    "appliedFields" JSONB NOT NULL DEFAULT '[]',
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "ignoredFields" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductIdentityPromotion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductIdentityPromotion_extractionId_key" ON "ProductIdentityPromotion"("extractionId");
CREATE UNIQUE INDEX "ProductIdentityPromotion_extractionId_sourceDocumentId_workspaceId_key"
    ON "ProductIdentityPromotion"("extractionId", "sourceDocumentId", "workspaceId");
CREATE INDEX "ProductIdentityPromotion_sourceDocumentId_workspaceId_createdAt_idx"
    ON "ProductIdentityPromotion"("sourceDocumentId", "workspaceId", "createdAt");

ALTER TABLE "ProductIdentityPromotion"
ADD CONSTRAINT "ProductIdentityPromotion_extractionId_sourceDocumentId_workspaceId_fkey"
FOREIGN KEY ("extractionId", "sourceDocumentId", "workspaceId")
REFERENCES "DocumentExtraction"("id", "sourceDocumentId", "workspaceId")
ON DELETE CASCADE ON UPDATE CASCADE;
