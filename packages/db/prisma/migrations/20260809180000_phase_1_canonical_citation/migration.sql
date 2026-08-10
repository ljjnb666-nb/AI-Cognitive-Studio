-- Gate 3 follows the unpublished Gate 2 migration in the same Phase 1 chain.
-- No production SourceBlock rows exist between these migrations; this migration
-- intentionally does not fabricate canonical text from offsets or hashes.

-- CreateEnum
CREATE TYPE "SourceBlockKind" AS ENUM ('HEADING', 'PARAGRAPH', 'LIST_ITEM', 'QUOTE', 'TABLE', 'IMAGE', 'CAPTION', 'FOOTNOTE', 'CODE', 'EQUATION', 'UNKNOWN');

-- AlterTable
ALTER TABLE "DocumentExtraction" ADD COLUMN     "normalizationVersion" TEXT NOT NULL,
ADD COLUMN     "parserName" TEXT NOT NULL,
ADD COLUMN     "parserVersion" TEXT NOT NULL,
ADD COLUMN     "sourceDocumentId" TEXT NOT NULL,
ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "SourceBlock" DROP COLUMN "textEnd",
DROP COLUMN "textStart",
ADD COLUMN     "bbox" JSONB,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "text" TEXT NOT NULL,
DROP COLUMN "kind",
ADD COLUMN     "kind" "SourceBlockKind" NOT NULL;

-- AlterTable
ALTER TABLE "SourcePage" ADD COLUMN     "height" DOUBLE PRECISION,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "width" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SourceSpan" DROP COLUMN "quote",
ADD COLUMN     "quoteHash" TEXT NOT NULL,
ADD COLUMN     "quoteText" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "CurrentDocumentExtraction" (
    "id" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentDocumentExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CurrentDocumentExtraction_sourceDocumentId_workspaceId_key" ON "CurrentDocumentExtraction"("sourceDocumentId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentDocumentExtraction_extractionId_sourceDocumentId_wor_key" ON "CurrentDocumentExtraction"("extractionId", "sourceDocumentId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExtraction_id_sourceDocumentId_workspaceId_key" ON "DocumentExtraction"("id", "sourceDocumentId", "workspaceId");

-- AddForeignKey
ALTER TABLE "DocumentExtraction" ADD CONSTRAINT "DocumentExtraction_sourceDocumentId_workspaceId_fkey" FOREIGN KEY ("sourceDocumentId", "workspaceId") REFERENCES "SourceDocument"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentDocumentExtraction" ADD CONSTRAINT "CurrentDocumentExtraction_sourceDocumentId_workspaceId_fkey" FOREIGN KEY ("sourceDocumentId", "workspaceId") REFERENCES "SourceDocument"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentDocumentExtraction" ADD CONSTRAINT "CurrentDocumentExtraction_extractionId_sourceDocumentId_wo_fkey" FOREIGN KEY ("extractionId", "sourceDocumentId", "workspaceId") REFERENCES "DocumentExtraction"("id", "sourceDocumentId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
