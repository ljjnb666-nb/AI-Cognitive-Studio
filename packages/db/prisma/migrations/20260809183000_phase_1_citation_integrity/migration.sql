-- DropForeignKey
ALTER TABLE "DocumentExtraction" DROP CONSTRAINT "DocumentExtraction_ingestionRunId_fkey";

-- DropForeignKey
ALTER TABLE "SourceBlock" DROP CONSTRAINT "SourceBlock_sourcePageId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExtraction_ingestionRunId_sourceDocumentId_workspac_key" ON "DocumentExtraction"("ingestionRunId", "sourceDocumentId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "IngestionRun_id_sourceDocumentId_workspaceId_key" ON "IngestionRun"("id", "sourceDocumentId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SourcePage_id_extractionId_key" ON "SourcePage"("id", "extractionId");

-- AddForeignKey
ALTER TABLE "DocumentExtraction" ADD CONSTRAINT "DocumentExtraction_ingestionRunId_sourceDocumentId_workspa_fkey" FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId") REFERENCES "IngestionRun"("id", "sourceDocumentId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceBlock" ADD CONSTRAINT "SourceBlock_sourcePageId_extractionId_fkey" FOREIGN KEY ("sourcePageId", "extractionId") REFERENCES "SourcePage"("id", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE;
